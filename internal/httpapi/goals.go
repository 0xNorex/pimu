package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/0xNorex/pimu/internal/store"
)

// Goals attach only to bots (docs/AUTONOMY.md). GOAL.md is the goal text the
// user writes; STATE.md and findings.md are the model's.

type goalIn struct {
	Title       *string `json:"title"`
	Goal        *string `json:"goal"` // GOAL.md
	Level       *int    `json:"level"`
	EveryMin    *int    `json:"everyMin"`
	ActiveHours *string `json:"activeHours"`
	RunSec      *int    `json:"runSec"`
	RunTokens   *int    `json:"runTokens"`
	DayTokens   *int    `json:"dayTokens"`
	Enabled     *bool   `json:"enabled"`
}

func (in goalIn) apply(g *store.Goal) string {
	if in.Title != nil {
		g.Title = strings.TrimSpace(*in.Title)
	}
	if in.Level != nil {
		g.Level = *in.Level
	}
	if in.EveryMin != nil {
		g.EverySec = *in.EveryMin * 60
	}
	if in.ActiveHours != nil {
		g.ActiveHours = strings.TrimSpace(*in.ActiveHours)
	}
	if in.RunSec != nil {
		g.RunSec = *in.RunSec
	}
	if in.RunTokens != nil {
		g.RunTokens = *in.RunTokens
	}
	if in.DayTokens != nil {
		g.DayTokens = *in.DayTokens
	}
	if in.Enabled != nil {
		g.Enabled = *in.Enabled
	}
	switch {
	case g.Title == "" || len([]rune(g.Title)) > 60:
		return "标题 1–60 字"
	case g.Level < 1 || g.Level > 2:
		return "自主级别只能是 L1（观察）或 L2（行动需审批）"
	case g.EverySec < 600:
		return "心跳间隔至少 10 分钟"
	case g.RunSec < 30 || g.RunSec > 3600:
		return "单次时长 30–3600 秒"
	case g.RunTokens < 1000 || g.DayTokens < g.RunTokens:
		return "token 上限：单次 ≥1000，且每日 ≥ 单次"
	}
	if g.ActiveHours != "" {
		a, b, ok := strings.Cut(g.ActiveHours, "-")
		x, e1 := strconv.Atoi(a)
		y, e2 := strconv.Atoi(b)
		if !ok || e1 != nil || e2 != nil || x < 0 || x > 23 || y < 0 || y > 24 {
			return "活跃时段格式如 8-23（本地时间，小时）"
		}
	}
	return ""
}

type goalOut struct {
	store.Goal
	TodayTokens int         `json:"todayTokens"`
	LastBeat    *store.Beat `json:"lastBeat"`
	Precheck    string      `json:"precheck"` // why the next precheck would skip; "" = would run
}

func (s *Server) goalOut(g store.Goal) goalOut {
	now := time.Now()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	tokens, _, _, _ := s.st.BeatStats(g.ID, day, now.Add(-time.Hour))
	out := goalOut{Goal: g, TodayTokens: tokens, Precheck: s.goals.Precheck(g, false)}
	if b, err := s.st.Beats(g.ID, 1); err == nil && len(b) > 0 {
		out.LastBeat = &b[0]
	}
	return out
}

func (s *Server) goalOrErr(w http.ResponseWriter, r *http.Request) (store.Goal, bool) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	g, err := s.st.Goal(id)
	if err != nil {
		if err == store.ErrNotFound {
			writeErr(w, 404, "not_found", "目标不存在")
		} else {
			writeErr(w, 500, "db_error", err.Error())
		}
		return g, false
	}
	return g, true
}

func (s *Server) handleGoalList(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.Goals(r.PathValue("id"))
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	out := make([]goalOut, 0, len(list))
	for _, g := range list {
		out = append(out, s.goalOut(g))
	}
	writeJSON(w, 200, map[string]any{"goals": out})
}

// handleGoalAll lists every goal with its bot name (settings overview).
func (s *Server) handleGoalAll(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.Goals("")
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	type row struct {
		goalOut
		BotName string `json:"botName"`
	}
	out := make([]row, 0, len(list))
	for _, g := range list {
		b, _ := s.st.Bot(g.BotID)
		out = append(out, row{s.goalOut(g), b.Name})
	}
	writeJSON(w, 200, map[string]any{"goals": out, "botsDir": s.goals.BotDir("<bot>")})
}

func (s *Server) handleGoalCreate(w http.ResponseWriter, r *http.Request) {
	bot, err := s.st.Bot(r.PathValue("id"))
	if err != nil {
		writeErr(w, 404, "not_found", "只有 Bot 才能加目标：先把会话设为 Bot")
		return
	}
	var in goalIn
	if !readJSON(w, r, &in) {
		return
	}
	g := store.Goal{BotID: bot.SessionID, Level: 1, EverySec: 3600, RunSec: 600, RunTokens: 200000, DayTokens: 1000000, Enabled: true}
	if msg := in.apply(&g); msg != "" {
		writeErr(w, 400, "invalid", msg)
		return
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	g.HookSecret = hex.EncodeToString(b)
	g, err = s.st.CreateGoal(g)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if in.Goal != nil {
		if err := s.goals.WriteGoalMD(g, *in.Goal); err != nil {
			writeErr(w, 500, "write_error", err.Error())
			return
		}
	}
	s.hub.Broadcast(map[string]any{"type": "goal_update", "goalId": g.ID})
	writeJSON(w, 200, map[string]any{"goal": s.goalOut(g)})
}

func (s *Server) handleGoalGet(w http.ResponseWriter, r *http.Request) {
	g, ok := s.goalOrErr(w, r)
	if !ok {
		return
	}
	beats, _ := s.st.Beats(g.ID, 20)
	hook := fmt.Sprintf("/api/goals/%d/hook?k=%s", g.ID, g.HookSecret)
	if s.cfg.PublicURL != "" {
		hook = s.cfg.PublicURL + hook
	}
	writeJSON(w, 200, map[string]any{
		"goal": s.goalOut(g), "goalMd": s.goals.ReadGoalMD(g), "stateMd": s.goals.ReadStateMD(g),
		"findings": s.goals.Findings(g, 20), "beats": beats, "hookUrl": hook, "dir": s.goals.GoalDir(g),
	})
}

func (s *Server) handleGoalPatch(w http.ResponseWriter, r *http.Request) {
	g, ok := s.goalOrErr(w, r)
	if !ok {
		return
	}
	var in goalIn
	if !readJSON(w, r, &in) {
		return
	}
	wasOff := !g.Enabled
	if msg := in.apply(&g); msg != "" {
		writeErr(w, 400, "invalid", msg)
		return
	}
	g, err := s.st.UpdateGoal(g)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if in.Goal != nil {
		if err := s.goals.WriteGoalMD(g, *in.Goal); err != nil {
			writeErr(w, 500, "write_error", err.Error())
			return
		}
	}
	if wasOff && g.Enabled {
		s.goals.Wake(g.ID)
	}
	s.hub.Broadcast(map[string]any{"type": "goal_update", "goalId": g.ID})
	writeJSON(w, 200, map[string]any{"goal": s.goalOut(g)})
}

func (s *Server) handleGoalDelete(w http.ResponseWriter, r *http.Request) {
	g, ok := s.goalOrErr(w, r)
	if !ok {
		return
	}
	if err := s.st.DeleteGoal(g.ID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true}) // files under bots/<id>/goals/ are kept
}

func (s *Server) handleGoalBeat(w http.ResponseWriter, r *http.Request) {
	g, ok := s.goalOrErr(w, r)
	if !ok {
		return
	}
	if err := s.goals.Beat(g.ID); err != nil {
		writeErr(w, 409, "skipped", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleGoalHook: POST /api/goals/{id}/hook?k=<secret>, body ≤64 KB. Dedup key:
// X-GitHub-Delivery, then X-Pimu-Dedup, then sha256(body).
func (s *Server) handleGoalHook(w http.ResponseWriter, r *http.Request) {
	g, ok := s.goalOrErr(w, r)
	if !ok {
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("k")), []byte(g.HookSecret)) != 1 {
		writeErr(w, 403, "forbidden", "bad hook secret")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		writeErr(w, 413, "too_large", "body > 64 KB")
		return
	}
	key := r.Header.Get("X-GitHub-Delivery")
	if key == "" {
		key = r.Header.Get("X-Pimu-Dedup")
	}
	if key == "" {
		sum := sha256.Sum256(body)
		key = hex.EncodeToString(sum[:])
	}
	payload := string(body)
	if ev := r.Header.Get("X-GitHub-Event"); ev != "" {
		payload = "X-GitHub-Event: " + ev + "\n" + payload
	}
	added, err := s.goals.Event(g.ID, "hook", "hook:"+key, payload)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "duplicate": !added})
}

// ---- inbox

func (s *Server) handleInbox(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := s.st.Items(q.Get("bot"), q.Get("open") == "1", 200)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *Server) handleInboxCount(w http.ResponseWriter, r *http.Request) {
	n, err := s.st.Unread()
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]int{"unread": n})
}

func (s *Server) handleInboxReadAll(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.Items("", true, 500)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	for _, it := range items {
		if it.Kind == "notify" {
			_, _ = s.st.SetItemStatus(it.ID, "read", "new")
		}
	}
	s.hub.Broadcast(map[string]any{"type": "inbox"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleInboxDecide: {action: read|approve|deny|answer, text}. A decision on an
// approval or question becomes a user event, which wakes the goal: the next
// heartbeat sees it and (for an approval) may run the approved call once.
func (s *Server) handleInboxDecide(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	it, err := s.st.Item(id)
	if err != nil {
		writeErr(w, 404, "not_found", "没有这条")
		return
	}
	var body struct {
		Action string `json:"action"`
		Text   string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	open := []string{"new", "read"}
	var event string
	switch {
	case body.Action == "read":
		_, err = s.st.SetItemStatus(id, "read", "new")
	case it.Kind == "notify":
		writeErr(w, 400, "invalid", "通知只能标记已读")
		return
	case body.Action == "approve" || body.Action == "answer":
		ok, e := s.st.SetItemStatus(id, "approved", open...)
		if err = e; err == nil && !ok {
			writeErr(w, 409, "decided", "已经处理过了")
			return
		}
		switch {
		case it.JobID != 0:
			s.jobs.SetWaiting(it.JobID, false)
		case it.Kind == "approval":
			event = fmt.Sprintf("用户批准了审批 #%d（%s）。现在可以再调用一次完全相同的工具和参数（一字不差），只允许一次：\n%s", id, it.Tool, it.Body)
		case it.Tool == "task":
			if err = s.goals.RunTask(it); err == nil {
				event = fmt.Sprintf("用户同意了子任务 #%d，已开始运行，结果会作为 task 事件送回。", id)
			}
		default:
			event = fmt.Sprintf("用户回答了问题 #%d「%s」：%s", id, it.Title, firstNonEmpty(strings.TrimSpace(body.Text), "同意"))
		}
	case body.Action == "deny":
		ok, e := s.st.SetItemStatus(id, "denied", open...)
		if err = e; err == nil && !ok {
			writeErr(w, 409, "decided", "已经处理过了")
			return
		}
		if it.JobID != 0 {
			s.jobs.SetWaiting(it.JobID, false)
		} else {
			event = fmt.Sprintf("用户拒绝了 #%d（%s「%s」）。不要再为同一件事请求。", id, it.Kind, it.Title)
		}
	default:
		writeErr(w, 400, "invalid", "action 只能是 read / approve / deny / answer")
		return
	}
	if err != nil {
		writeErr(w, 500, "error", err.Error())
		return
	}
	if event != "" {
		_, _ = s.goals.Event(it.GoalID, "user", fmt.Sprintf("decision:%d", id), event)
	}
	s.hub.Broadcast(map[string]any{"type": "inbox"})
	it, _ = s.st.Item(id)
	writeJSON(w, 200, map[string]any{"item": it})
}

// ---- internal (pimu-agent.ts)

func (s *Server) internalOK(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Pimu-Internal")), []byte(s.goals.Token)) != 1 {
		writeErr(w, 403, "forbidden", "internal only")
		return false
	}
	return true
}

// handleApprovalRequest is deny-and-defer: the gate blocks the call and asks
// for an approval row keyed by sha256(goal|tool|canonical args). The answer is
// the row's status: new/read (pending), approved (allow once), used, denied.
func (s *Server) handleApprovalRequest(w http.ResponseWriter, r *http.Request) {
	if !s.internalOK(w, r) {
		return
	}
	var body struct {
		Goal     int64          `json:"goal"`
		Job      int64          `json:"job"`
		Tool     string         `json:"tool"`
		ArgsHash string         `json:"argsHash"`
		Args     map[string]any `json:"args"`
		Reason   string         `json:"reason"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if (body.Goal == 0) == (body.Job == 0) || body.Tool == "" || len(body.ArgsHash) != 64 {
		writeErr(w, 400, "invalid", "goal or job, tool, argsHash required")
		return
	}
	botID := ""
	if body.Job != 0 {
		j, err := s.st.Job(body.Job)
		if err != nil {
			writeErr(w, 404, "not_found", "job")
			return
		}
		botID = j.BotID
	}
	shown, _ := json.MarshalIndent(mask(map[string]any(body.Args)), "", "  ") // never show credentials
	it, isNew, err := s.st.AddItem(store.Item{BotID: botID, GoalID: body.Goal, JobID: body.Job, Kind: "approval", DedupKey: "ap:" + body.ArgsHash,
		Title: clipText(fmt.Sprintf("想调用 %s：%s", body.Tool, body.Reason), 200), Body: clipText(string(shown), 4000), Tool: body.Tool, ArgsHash: body.ArgsHash})
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if isNew {
		s.goals.Alert(it)
	}
	if body.Job != 0 && (it.Status == "new" || it.Status == "read") {
		s.jobs.SetWaiting(body.Job, true) // the gate now polls until the user decides
	}
	writeJSON(w, 200, map[string]any{"id": it.ID, "status": it.Status})
}

// handleApprovalStatus is polled by a job's gate while it waits for the user.
func (s *Server) handleApprovalStatus(w http.ResponseWriter, r *http.Request) {
	if !s.internalOK(w, r) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	it, err := s.st.Item(id)
	if err != nil {
		writeErr(w, 404, "not_found", "item")
		return
	}
	writeJSON(w, 200, map[string]any{"id": it.ID, "status": it.Status})
}

func (s *Server) handleApprovalUsed(w http.ResponseWriter, r *http.Request) {
	if !s.internalOK(w, r) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	ok, err := s.st.SetItemStatus(id, "used", "approved")
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	s.hub.Broadcast(map[string]any{"type": "inbox"})
	writeJSON(w, 200, map[string]bool{"ok": ok})
}

func clipText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
