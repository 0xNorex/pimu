// Package jobs runs background work a bot delegates with the pimu_task tool.
// Each job is its own pi RPC session (same models, MCP and extensions, gated at
// L2 so risky calls wait for approval), at most Max at a time, FIFO otherwise.
// The result goes back into the bot's main session as a follow-up prompt and
// into the inbox. Jobs left running by a dead Pimu become "interrupted"; they
// are never re-run on their own.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/store"
)

const (
	maxRun     = time.Hour
	resultMax  = 8000
	callWait   = 30 * time.Second
	retryEvery = 30 * time.Second
)

var sessionRe = regexp.MustCompile(`^pimu-j(\d+)$`)

func SessionID(id int64) string { return fmt.Sprintf("pimu-j%d", id) }

type Service struct {
	st     *store.Store
	hub    *hub.Hub
	Max    int
	Alert  func(store.Item) // inbox broadcast + Telegram
	BotEnv func(botID string) []string

	ctx     context.Context
	wake    chan struct{}
	mu      sync.Mutex
	running map[int64]context.CancelFunc
}

func New(st *store.Store, h *hub.Hub, max int) *Service {
	return &Service{st: st, hub: h, Max: max, wake: make(chan struct{}, 1), running: map[int64]context.CancelFunc{}}
}

// Extras gives a job session its env: the bot's dir, L2 gate, and the job id
// the gate files approvals under.
func (s *Service) Extras(id string) (args, env []string, ok bool) {
	m := sessionRe.FindStringSubmatch(id)
	if m == nil {
		return nil, nil, false
	}
	jid, _ := strconv.ParseInt(m[1], 10, 64)
	j, err := s.st.Job(jid)
	if err != nil {
		return nil, nil, false
	}
	env = append(s.BotEnv(j.BotID), "PIMU_JOB="+m[1], "PIMU_LEVEL=2")
	return []string{"--name", "⇢ " + j.Title}, env, true
}

func (s *Service) Start(ctx context.Context) {
	s.ctx = ctx
	if n, err := s.st.InterruptJobs(); err != nil {
		slog.Error("interrupt jobs", "err", err)
	} else if n > 0 {
		slog.Warn("jobs interrupted by restart", "n", n)
	}
	go func() {
		t := time.NewTicker(retryEvery)
		defer t.Stop()
		for {
			s.schedule()
			s.deliverPending()
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-s.wake:
			}
		}
	}()
}

func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Create queues a job for a bot and returns it with its queue position.
func (s *Service) Create(botID, title, prompt string) (store.Job, int, error) {
	if _, err := s.st.Bot(botID); err != nil {
		return store.Job{}, 0, errors.New("只有 Bot 能派后台任务")
	}
	j, err := s.st.CreateJob(botID, title, prompt)
	if err != nil {
		return j, 0, err
	}
	pos := s.st.QueuePos(j.ID)
	s.mu.Lock()
	pos += len(s.running)
	s.mu.Unlock()
	s.publish(j.ID)
	s.Wake()
	return j, pos, nil
}

func (s *Service) schedule() {
	for {
		s.mu.Lock()
		free := s.Max - len(s.running)
		s.mu.Unlock()
		if free <= 0 {
			return
		}
		q, err := s.st.QueuedJobs()
		if err != nil || len(q) == 0 {
			return
		}
		j := q[0]
		if ok, err := s.st.StartJob(j.ID, SessionID(j.ID)); err != nil || !ok {
			return
		}
		ctx, cancel := context.WithTimeout(s.ctx, maxRun)
		s.mu.Lock()
		s.running[j.ID] = cancel
		s.mu.Unlock()
		go func() {
			defer cancel()
			status, result, errText, tokens := s.run(ctx, j)
			s.mu.Lock()
			delete(s.running, j.ID)
			s.mu.Unlock()
			s.finish(j, status, result, errText, tokens)
			s.Wake()
		}()
	}
}

func (s *Service) run(ctx context.Context, j store.Job) (status, result, errText string, tokens int) {
	bot, err := s.st.Bot(j.BotID)
	if err != nil {
		return "failed", "", "bot 不存在", 0
	}
	sid := SessionID(j.ID)
	s.publish(j.ID)
	var r *hub.Run
	for {
		r, err = s.hub.CreateWithID(ctx, sid, bot.Cwd)
		if !errors.Is(err, hub.ErrTooMany) {
			break
		}
		select {
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
			return s.stopped(ctx), "", "等不到空闲的 pi 进程", 0
		}
	}
	if err != nil {
		return "failed", "", err.Error(), 0
	}
	defer s.hub.Release(context.Background(), sid)

	stream := s.hub.Stream(sid)
	ch, _, _ := stream.Subscribe(stream.Seq())
	defer func() { stream.Unsubscribe(ch) }()

	prompt := fmt.Sprintf("你是 Bot「%s」派出的后台子任务，没有人在实时看你。独立完成下面的任务；需要批准的操作会自动等用户批准。\n"+
		"结束时用简洁中文写出结果（结论在前，必要的细节在后），这段话会原样送回主会话。\n\n# %s\n\n%s", bot.Name, j.Title, j.Prompt)
	if resp, err := s.hub.Call(ctx, r, map[string]any{"type": "prompt", "message": prompt}, callWait); err != nil || !resp.Success {
		return "failed", "", "prompt: " + firstErr(err, resp.Error), 0
	}

	var stopReason, stopErr string
	for done := false; !done; {
		select {
		case ev, ok := <-ch:
			if !ok {
				ch, _, _ = stream.Subscribe(stream.Seq()) // slow subscriber: keep going, tokens may undercount
				continue
			}
			var m struct {
				Type    string `json:"type"`
				Message struct {
					Role         string `json:"role"`
					StopReason   string `json:"stopReason"`
					ErrorMessage string `json:"errorMessage"`
					Usage        struct {
						TotalTokens int `json:"totalTokens"`
					} `json:"usage"`
				} `json:"message"`
			}
			if ev.Kind != "pi" || json.Unmarshal(ev.Data, &m) != nil {
				continue
			}
			switch m.Type {
			case "message_end":
				if m.Message.Role == "assistant" {
					tokens += m.Message.Usage.TotalTokens
					stopReason, stopErr = m.Message.StopReason, m.Message.ErrorMessage
				}
			case "agent_settled":
				done = true
			}
		case <-r.Done():
			return "failed", "", "pi 意外退出", tokens
		case <-ctx.Done():
			actx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, _ = s.hub.Call(actx, r, map[string]any{"type": "abort"}, 5*time.Second)
			cancel()
			return s.stopped(ctx), "", map[string]string{"cancelled": "已取消", "failed": "超时（1 小时）"}[s.stopped(ctx)], tokens
		}
	}
	if resp, err := s.hub.Call(context.Background(), r, map[string]any{"type": "get_last_assistant_text"}, callWait); err == nil && resp.Success {
		var d struct {
			Text *string `json:"text"`
		}
		if json.Unmarshal(resp.Data, &d) == nil && d.Text != nil {
			result = clip(*d.Text, resultMax)
		}
	}
	if stopReason == "error" || stopReason == "aborted" {
		return "failed", result, firstNonEmpty(stopErr, "模型出错"), tokens
	}
	return "completed", result, "", tokens
}

// stopped tells a user cancel (Canceled) from the time limit.
func (s *Service) stopped(ctx context.Context) string {
	if errors.Is(ctx.Err(), context.Canceled) && s.ctx.Err() == nil {
		return "cancelled"
	}
	return "failed"
}

func (s *Service) finish(j store.Job, status, result, errText string, tokens int) {
	if s.ctx.Err() != nil { // Pimu is shutting down: leave it for InterruptJobs
		return
	}
	if err := s.st.FinishJob(j.ID, status, result, errText, tokens); err != nil {
		slog.Error("finish job", "job", j.ID, "err", err)
	}
	slog.Info("job finished", "job", j.ID, "status", status, "tokens", tokens, "err", errText)
	_ = s.st.ExpireJobItems(j.ID)
	s.hub.Broadcast(map[string]any{"type": "inbox"})
	s.publish(j.ID)
	if status == "cancelled" {
		s.Wake() // deliverPending tells the bot, so it does not think the job still runs
		return
	}
	label := map[string]string{"completed": "完成", "failed": "失败"}[status]
	it, isNew, err := s.st.AddItem(store.Item{BotID: j.BotID, JobID: j.ID, Kind: "notify", DedupKey: "job:done",
		Title: fmt.Sprintf("后台任务%s：%s", label, j.Title), Body: clip(firstNonEmpty(result, errText), 2000)})
	if err == nil && isNew && s.Alert != nil {
		s.Alert(it)
	}
	if j, err := s.st.Job(j.ID); err == nil {
		s.deliver(j)
	}
}

// deliver hands the result to the bot's main session: a prompt that starts a
// turn when idle, or queues as a follow-up while the user is mid-conversation.
func (s *Service) deliver(j store.Job) {
	ctx, cancel := context.WithTimeout(s.ctx, time.Minute)
	defer cancel()
	r, err := s.hub.Ensure(ctx, j.BotID)
	if err != nil {
		slog.Warn("deliver job: bot session unavailable, will retry", "job", j.ID, "err", err)
		return
	}
	body := firstNonEmpty(j.Result, "（没有文字结果）")
	switch j.Status {
	case "failed":
		body = "失败：" + firstNonEmpty(j.Error, "未知错误") + "\n\n" + j.Result
	case "cancelled":
		body = "用户取消了这个任务，没有结果。"
	}
	msg := fmt.Sprintf("[Pimu 后台任务 #%d「%s」已%s]\n\n%s\n\n（这是你之前用 pimu_task 派出去的任务，结果由 Pimu 自动送回。请用一两句话向用户汇报要点。）",
		j.ID, j.Title, map[string]string{"completed": "完成", "failed": "失败", "cancelled": "取消"}[j.Status], body)
	resp, err := s.hub.Call(ctx, r, map[string]any{"type": "prompt", "message": msg, "streamingBehavior": "followUp"}, callWait)
	if err != nil || !resp.Success {
		slog.Warn("deliver job failed, will retry", "job", j.ID, "err", firstErr(err, resp.Error))
		return
	}
	_ = s.st.SetJobDelivered(j.ID)
	s.publish(j.ID)
}

func (s *Service) deliverPending() {
	js, err := s.st.UndeliveredJobs()
	if err != nil {
		return
	}
	for _, j := range js {
		s.deliver(j)
	}
}

// Cancel stops a queued or running job.
func (s *Service) Cancel(id int64) error {
	if ok, err := s.st.SetJobStatus(id, "cancelled", "queued", "interrupted"); err != nil || ok {
		if ok {
			_ = s.st.FinishJob(id, "cancelled", "", "已取消", 0)
			_ = s.st.ExpireJobItems(id)
			s.publish(id)
			s.Wake()
		}
		return err
	}
	s.mu.Lock()
	cancel := s.running[id]
	s.mu.Unlock()
	if cancel == nil {
		return errors.New("任务不在运行")
	}
	cancel()
	return nil
}

// Steer appends an instruction to a running job (delivered after its current tool calls).
func (s *Service) Steer(id int64, text string) error {
	r := s.hub.Running(SessionID(id))
	if r == nil {
		return errors.New("任务不在运行")
	}
	resp, err := s.hub.Call(s.ctx, r, map[string]any{"type": "prompt", "message": "用户追加指示：" + text, "streamingBehavior": "steer"}, callWait)
	if err != nil {
		return err
	}
	if !resp.Success {
		return errors.New(resp.Error)
	}
	return nil
}

// Rerun queues a fresh copy of a finished/interrupted job.
func (s *Service) Rerun(id int64) (store.Job, int, error) {
	j, err := s.st.Job(id)
	if err != nil {
		return j, 0, err
	}
	return s.Create(j.BotID, j.Title, j.Prompt)
}

// SetWaiting flips running <-> waiting_approval while the gate waits on the user.
func (s *Service) SetWaiting(id int64, waiting bool) {
	from, to := "running", "waiting_approval"
	if !waiting {
		from, to = to, from
	}
	if ok, _ := s.st.SetJobStatus(id, to, from); ok {
		s.publish(id)
	}
}

func (s *Service) publish(id int64) {
	if j, err := s.st.Job(id); err == nil {
		s.hub.Broadcast(map[string]any{"type": "job_update", "job": j})
	}
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func firstErr(err error, msg string) string {
	if err != nil {
		return err.Error()
	}
	return msg
}
