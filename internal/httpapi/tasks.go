package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/0xNorex/pimu/internal/store"
	"github.com/0xNorex/pimu/internal/tasks"
)

type taskOut struct {
	store.Task
	NextRun *time.Time `json:"nextRun"`
	LastRun *store.Run `json:"lastRun"`
}

func (s *Server) taskOut(t store.Task) taskOut {
	out := taskOut{Task: t, NextRun: s.tasks.Next(t.ID)}
	if runs, err := s.st.Runs(t.ID, "", 1); err == nil && len(runs) > 0 {
		out.LastRun = &runs[0]
	}
	return out
}

func taskID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, 404, "not_found", "任务不存在")
		return 0, false
	}
	return id, true
}

func (s *Server) storeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "not_found", "任务不存在")
		return
	}
	writeErr(w, 500, "db_error", err.Error())
}

// validate normalises t in place and returns a user-facing error message.
func (s *Server) validate(t *store.Task) string {
	t.Name, t.Prompt = strings.TrimSpace(t.Name), strings.TrimSpace(t.Prompt)
	if t.Name == "" || t.Prompt == "" {
		return "名称和提示词不能为空"
	}
	cwd, ok := s.cfg.AllowedDir(t.Cwd)
	if !ok {
		return "cwd 不在 PIMU_WORKDIRS 允许范围内或不存在"
	}
	t.Cwd = cwd
	for _, p := range []**string{&t.Schedule, &t.Model, &t.SessionID} {
		if *p != nil {
			if v := strings.TrimSpace(**p); v == "" {
				*p = nil
			} else {
				*p = &v
			}
		}
	}
	if t.Schedule != nil {
		if err := tasks.ParseSchedule(*t.Schedule); err != nil {
			return "cron 表达式无效（5 段：分 时 日 月 周）：" + err.Error()
		}
	}
	if t.Model != nil && !strings.Contains(*t.Model, "/") {
		return "模型格式应为 provider/modelId"
	}
	switch t.SessionMode {
	case "new":
	case "reuse":
		if t.SessionID == nil {
			return "复用会话模式需要填写会话 ID"
		}
	default:
		return "sessionMode 只能是 new 或 reuse"
	}
	if t.Notify != "always" && t.Notify != "failure" && t.Notify != "never" {
		return "notify 只能是 always、failure 或 never"
	}
	if t.MaxRetries < 0 || t.MaxRetries > 5 {
		return "重试次数范围 0–5"
	}
	if t.TimeoutSec < 30 || t.TimeoutSec > 86400 {
		return "超时范围 30–86400 秒"
	}
	return ""
}

func (s *Server) handleTaskList(w http.ResponseWriter, r *http.Request) {
	ts, err := s.st.Tasks()
	if err != nil {
		s.storeErr(w, err)
		return
	}
	out := make([]taskOut, 0, len(ts))
	for _, t := range ts {
		out = append(out, s.taskOut(t))
	}
	writeJSON(w, 200, map[string]any{"tasks": out})
}

func (s *Server) handleTaskCreate(w http.ResponseWriter, r *http.Request) {
	t := store.Task{SessionMode: "new", Notify: "failure", MaxRetries: 1, TimeoutSec: 1800, Enabled: true}
	if !readJSON(w, r, &t) {
		return
	}
	if msg := s.validate(&t); msg != "" {
		writeErr(w, 400, "invalid", msg)
		return
	}
	t, err := s.st.CreateTask(t)
	if err != nil {
		s.storeErr(w, err)
		return
	}
	s.tasks.Sync(t)
	writeJSON(w, 200, map[string]any{"task": s.taskOut(t)})
}

func (s *Server) handleTaskGet(w http.ResponseWriter, r *http.Request) {
	id, ok := taskID(w, r)
	if !ok {
		return
	}
	t, err := s.st.Task(id)
	if err != nil {
		s.storeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"task": s.taskOut(t)})
}

// handleTaskPatch overlays the JSON body on the stored task.
func (s *Server) handleTaskPatch(w http.ResponseWriter, r *http.Request) {
	id, ok := taskID(w, r)
	if !ok {
		return
	}
	t, err := s.st.Task(id)
	if err != nil {
		s.storeErr(w, err)
		return
	}
	if !readJSON(w, r, &t) {
		return
	}
	t.ID = id
	if msg := s.validate(&t); msg != "" {
		writeErr(w, 400, "invalid", msg)
		return
	}
	if t, err = s.st.UpdateTask(t); err != nil {
		s.storeErr(w, err)
		return
	}
	s.tasks.Sync(t)
	writeJSON(w, 200, map[string]any{"task": s.taskOut(t)})
}

func (s *Server) handleTaskDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := taskID(w, r)
	if !ok {
		return
	}
	if err := s.st.DeleteTask(id); err != nil {
		s.storeErr(w, err)
		return
	}
	s.tasks.Remove(id)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleTaskRun(w http.ResponseWriter, r *http.Request) {
	id, ok := taskID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.Task(id); err != nil {
		s.storeErr(w, err)
		return
	}
	run, err := s.tasks.Trigger(id, "manual", 1)
	if err != nil {
		s.storeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"run": run})
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tid, _ := strconv.ParseInt(q.Get("task_id"), 10, 64)
	limit, err := strconv.Atoi(q.Get("limit"))
	if err != nil || limit <= 0 || limit > 500 {
		limit = 50
	}
	runs, err := s.st.Runs(tid, q.Get("status"), limit)
	if err != nil {
		s.storeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"runs": runs})
}
