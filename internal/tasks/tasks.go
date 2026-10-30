// Package tasks schedules and executes Pimu tasks. Each run is a fresh pi RPC
// process managed by the hub, so a run is also an ordinary, viewable session.
package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/notify"
	"github.com/0xNorex/pimu/internal/store"
)

const (
	retryDelay  = time.Minute
	slotPoll    = 5 * time.Second
	callTimeout = 30 * time.Second
	summaryMax  = 2000
	notifyMax   = 500
)

type Service struct {
	st        *store.Store
	hub       *hub.Hub
	tg        notify.Telegram
	publicURL string

	cron    *cron.Cron
	mu      sync.Mutex
	entries map[int64]cron.EntryID
	ctx     context.Context

	// OnFinish, if set, sees every finished run (goals turn subtask results into events).
	OnFinish func(taskID int64, run store.Run, status, summary, errText string)
}

func New(st *store.Store, h *hub.Hub, tg notify.Telegram, publicURL string) *Service {
	return &Service{st: st, hub: h, tg: tg, publicURL: publicURL, cron: cron.New(), entries: map[int64]cron.EntryID{}}
}

// ParseSchedule validates a standard 5-field cron expression (server local time).
func ParseSchedule(spec string) error {
	_, err := cron.ParseStandard(spec)
	return err
}

// Start recovers runs interrupted by a restart, registers schedules and starts
// the cron loop. Missed cron slots while Pimu was down are not backfilled.
func (s *Service) Start(ctx context.Context) error {
	s.ctx = ctx
	queued, err := s.st.Runs(0, "queued", 1000) // before finish() below queues delayed retries
	if err != nil {
		return err
	}
	running, err := s.st.Runs(0, "running", 1000)
	if err != nil {
		return err
	}
	for _, r := range running {
		slog.Warn("run interrupted by restart", "run", r.ID, "task", r.TaskID)
		s.finish(r, "failed", "", "interrupted: pimu restarted")
	}
	for _, r := range queued {
		go s.execute(r)
	}
	tasks, err := s.st.Tasks()
	if err != nil {
		return err
	}
	for _, t := range tasks {
		s.Sync(t)
	}
	s.cron.Start()
	return nil
}

func (s *Service) Stop() { <-s.cron.Stop().Done() }

// Sync (re)registers a task's schedule after create/update.
func (s *Service) Sync(t store.Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.entries[t.ID]; ok {
		s.cron.Remove(id)
		delete(s.entries, t.ID)
	}
	if !t.Enabled || t.Schedule == nil || *t.Schedule == "" {
		return
	}
	taskID := t.ID
	id, err := s.cron.AddFunc(*t.Schedule, func() { s.fire(taskID) })
	if err != nil {
		slog.Error("bad schedule", "task", t.ID, "err", err)
		return
	}
	s.entries[t.ID] = id
}

func (s *Service) Remove(taskID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.entries[taskID]; ok {
		s.cron.Remove(id)
		delete(s.entries, taskID)
	}
}

// Next returns the next scheduled fire time, if any.
func (s *Service) Next(taskID int64) *time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.entries[taskID]
	if !ok {
		return nil
	}
	n := s.cron.Entry(id).Next
	if n.IsZero() {
		return nil
	}
	return &n
}

func (s *Service) fire(taskID int64) {
	if busy, err := s.st.Active(taskID); err != nil || busy {
		slog.Info("cron skipped: previous run still active", "task", taskID)
		return
	}
	if _, err := s.Trigger(taskID, "cron", 1); err != nil {
		slog.Error("cron trigger", "task", taskID, "err", err)
	}
}

// Trigger queues a run and starts it now.
func (s *Service) Trigger(taskID int64, trigger string, attempt int) (store.Run, error) {
	r, err := s.st.CreateRun(taskID, trigger, attempt)
	if err != nil {
		return r, err
	}
	s.publish(r.ID)
	go s.execute(r)
	return r, nil
}

func (s *Service) publish(runID int64) {
	if r, err := s.st.Run(runID); err == nil {
		s.hub.Broadcast(map[string]any{"type": "run_update", "run": r})
	}
}

func (s *Service) execute(run store.Run) {
	if s.ctx.Err() != nil {
		return // shutting down: the queued row is picked up on next start
	}
	if cur, err := s.st.Run(run.ID); err != nil || cur.Status != "queued" {
		return // deleted with its task, or already handled
	}
	t, err := s.st.Task(run.TaskID)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, time.Duration(t.TimeoutSec)*time.Second)
	defer cancel()
	status, summary, errText := s.runOnce(ctx, t, run)
	s.finish(run, status, summary, errText)
}

// runOnce does steps 1-6 of the DESIGN run flow and always closes pi.
func (s *Service) runOnce(ctx context.Context, t store.Task, run store.Run) (status, summary, errText string) {
	sid := fmt.Sprintf("pimu-t%d-r%d", t.ID, run.ID)
	if t.SessionMode == "reuse" {
		if t.SessionID == nil || *t.SessionID == "" {
			return "failed", "", "reuse mode needs a session id"
		}
		sid = *t.SessionID
		if r := s.hub.Running(sid); r != nil && r.Streaming() {
			return "failed", "", "session busy"
		}
	}
	// A reused session (a bot) that is already open stays open afterwards.
	keepOpen := t.SessionMode == "reuse" && s.hub.Running(sid) != nil
	var r *hub.Run
	for {
		var err error
		if t.SessionMode == "reuse" {
			r, err = s.hub.Ensure(ctx, sid)
		} else {
			r, err = s.hub.CreateWithID(ctx, sid, t.Cwd)
		}
		if errors.Is(err, hub.ErrTooMany) {
			select {
			case <-time.After(slotPoll):
				continue
			case <-ctx.Done():
				return "failed", "", "timeout waiting for a free pi slot"
			}
		}
		if errors.Is(err, hub.ErrLocked) {
			return "failed", "", "session busy"
		}
		if err != nil {
			return "failed", "", err.Error()
		}
		break
	}
	if !keepOpen {
		defer s.hub.Release(context.Background(), sid)
	}
	if err := s.st.StartRun(run.ID, sid); err != nil {
		return "failed", "", err.Error()
	}
	s.publish(run.ID)

	stream := s.hub.Stream(sid)
	last := stream.Seq()
	ch, _, _ := stream.Subscribe(last)
	defer func() { stream.Unsubscribe(ch) }()

	if t.Model != nil && *t.Model != "" {
		provider, model, ok := strings.Cut(*t.Model, "/")
		if !ok {
			return "failed", "", "model must be provider/modelId"
		}
		if err := s.call(ctx, r, map[string]any{"type": "set_model", "provider": provider, "modelId": model}); err != nil {
			return "failed", "", "set_model: " + err.Error()
		}
	}
	if err := s.call(ctx, r, map[string]any{"type": "prompt", "message": t.Prompt}); err != nil {
		return "failed", "", "prompt: " + err.Error()
	}

	var stopReason, stopErr string
	aborted := false
wait:
	for {
		select {
		case ev, ok := <-ch:
			if !ok { // dropped as a slow subscriber: resubscribe and replay
				var replay []hub.Event
				ch, replay, _ = stream.Subscribe(last)
				for _, e := range replay {
					if done, ab := scan(e, &stopReason, &stopErr); done {
						aborted = ab
						break wait
					}
					last = e.ID
				}
				continue
			}
			last = ev.ID
			if done, ab := scan(ev, &stopReason, &stopErr); done {
				aborted = ab
				break wait
			}
		case <-r.Done():
			return "failed", "", "pi exited unexpectedly"
		case <-ctx.Done():
			_, _ = s.hub.Call(context.Background(), r, map[string]any{"type": "abort"}, callTimeout)
			return "failed", "", "timeout"
		}
	}

	resp, err := s.hub.Call(ctx, r, map[string]any{"type": "get_last_assistant_text"}, callTimeout)
	if err == nil && resp.Success {
		var d struct {
			Text *string `json:"text"`
		}
		_ = json.Unmarshal(resp.Data, &d)
		if d.Text != nil {
			summary = clip(*d.Text, summaryMax)
		}
	}
	switch {
	case aborted:
		return "aborted", summary, "aborted"
	case stopReason == "error":
		return "failed", summary, firstNonEmpty(stopErr, "model error")
	}
	return "succeeded", summary, ""
}

func (s *Service) call(ctx context.Context, r *hub.Run, cmd map[string]any) error {
	resp, err := s.hub.Call(ctx, r, cmd, callTimeout)
	if err != nil {
		return err
	}
	if !resp.Success {
		return errors.New(resp.Error)
	}
	return nil
}

// scan tracks the last assistant stopReason and reports agent_settled.
func scan(ev hub.Event, stopReason, stopErr *string) (done, aborted bool) {
	if ev.Kind != "pi" {
		return false, false
	}
	var e struct {
		Type    string `json:"type"`
		Aborted bool   `json:"aborted"`
		Message struct {
			Role         string `json:"role"`
			StopReason   string `json:"stopReason"`
			ErrorMessage string `json:"errorMessage"`
		} `json:"message"`
	}
	if json.Unmarshal(ev.Data, &e) != nil {
		return false, false
	}
	switch e.Type {
	case "message_end":
		if e.Message.Role == "assistant" {
			*stopReason, *stopErr = e.Message.StopReason, e.Message.ErrorMessage
		}
	case "agent_settled":
		return true, e.Aborted
	}
	return false, false
}

func (s *Service) finish(run store.Run, status, summary, errText string) {
	if s.ctx.Err() != nil {
		return // shutting down: leave the row running; Start marks it interrupted
	}
	if err := s.st.FinishRun(run.ID, status, summary, errText); err != nil {
		slog.Error("finish run", "run", run.ID, "err", err)
		return
	}
	s.publish(run.ID)
	slog.Info("run finished", "run", run.ID, "task", run.TaskID, "status", status, "err", errText)
	t, err := s.st.Task(run.TaskID)
	if err != nil {
		return
	}
	if s.OnFinish != nil {
		go s.OnFinish(t.ID, run, status, summary, errText)
	}
	if t.Notify == "always" || (t.Notify == "failure" && status == "failed") {
		go s.notify(t, run, status, summary, errText)
	}
	// max_retries counts extra attempts: 1 means one retry after the first failure.
	if status == "failed" && run.Attempt <= t.MaxRetries && t.Enabled {
		next, err := s.st.CreateRun(t.ID, "retry", run.Attempt+1)
		if err != nil {
			slog.Error("queue retry", "task", t.ID, "err", err)
			return
		}
		s.publish(next.ID)
		time.AfterFunc(retryDelay, func() { s.execute(next) })
	}
}

func (s *Service) notify(t store.Task, run store.Run, status, summary, errText string) {
	if !s.tg.Enabled() {
		return
	}
	label := map[string]string{"succeeded": "成功", "failed": "失败", "aborted": "已中止"}[status]
	msg := fmt.Sprintf("Pimu 任务「%s」%s（第 %d 次）", t.Name, label, run.Attempt)
	if body := firstNonEmpty(summary, errText); body != "" {
		msg += "\n\n" + clip(body, notifyMax)
	}
	if r, err := s.st.Run(run.ID); err == nil && r.SessionID != nil && s.publicURL != "" {
		msg += "\n\n" + s.publicURL + "/#/s/" + *r.SessionID
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := s.tg.Send(ctx, msg); err != nil {
		slog.Warn("telegram notify failed", "task", t.ID, "run", run.ID, "err", err)
	}
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}
