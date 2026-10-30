package httpapi

import (
	"net/http"
	"strconv"
	"strings"
)

// handleJobDelegate is the pimu_task tool (pimu-agent.ts in a bot session).
func (s *Server) handleJobDelegate(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.internalScope(w, r)
	if !ok {
		return
	}
	if sc.Goal != 0 || sc.Job != 0 { // only a bot's main session delegates, and only to itself
		writeErr(w, 403, "forbidden", "only a bot's main session can delegate")
		return
	}
	var body struct {
		Title  string `json:"title"`
		Prompt string `json:"prompt"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	body.Title, body.Prompt = strings.TrimSpace(body.Title), strings.TrimSpace(body.Prompt)
	if body.Prompt == "" {
		writeErr(w, 400, "invalid", "prompt required")
		return
	}
	if body.Title == "" {
		body.Title = clipText(body.Prompt, 30)
	}
	j, pos, err := s.jobs.Create(sc.Bot, clipText(body.Title, 80), clipText(body.Prompt, 20000))
	if err != nil {
		writeErr(w, 400, "invalid", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": j.ID, "status": j.Status, "ahead": pos})
}

func (s *Server) handleJobList(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.Jobs(r.PathValue("id"), 50)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"jobs": list})
}

func (s *Server) handleJobGet(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	j, err := s.st.Job(id)
	if err != nil {
		writeErr(w, 404, "not_found", "任务不存在")
		return
	}
	writeJSON(w, 200, map[string]any{"job": j})
}

func (s *Server) handleJobAction(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var body struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var err error
	switch r.PathValue("action") {
	case "cancel":
		err = s.jobs.Cancel(id)
	case "steer":
		if strings.TrimSpace(body.Text) == "" {
			writeErr(w, 400, "invalid", "text required")
			return
		}
		err = s.jobs.Steer(id, strings.TrimSpace(body.Text))
	case "rerun":
		j, _, e := s.jobs.Rerun(id)
		if e == nil {
			writeJSON(w, 200, map[string]any{"job": j})
			return
		}
		err = e
	default:
		writeErr(w, 404, "not_found", "unknown action")
		return
	}
	if err != nil {
		writeErr(w, 409, "invalid", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
