// Package httpapi serves the JSON API, the SSE event stream and the
// embedded web UI.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/pirpc"
	"github.com/0xNorex/pimu/internal/sessions"
)

type Server struct {
	cfg       *config.Config
	hub       *hub.Hub
	version   string
	piVersion string
	limiter   *limiter
}

func New(cfg *config.Config, h *hub.Hub, version, piVersion string) *Server {
	return &Server{cfg: cfg, hub: h, version: version, piVersion: piVersion, limiter: &limiter{hits: map[string][]time.Time{}}}
}

func (s *Server) Handler(static fs.FS) http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/health", s.handleHealth)
	api.HandleFunc("POST /api/login", s.handleLogin)
	api.HandleFunc("POST /api/logout", s.handleLogout)
	api.HandleFunc("GET /api/workdirs", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"workdirs": s.cfg.Workdirs})
	})
	api.HandleFunc("GET /api/models", s.handleModels)
	api.HandleFunc("GET /api/sessions", s.handleList)
	api.HandleFunc("POST /api/sessions", s.handleCreate)
	api.HandleFunc("GET /api/sessions/{id}", s.handleGet)
	api.HandleFunc("GET /api/sessions/{id}/messages", s.handleMessages)
	api.HandleFunc("GET /api/sessions/{id}/events", s.handleEvents)
	api.HandleFunc("POST /api/sessions/{id}/prompt", s.handlePrompt)
	api.HandleFunc("POST /api/sessions/{id}/abort", s.handleAbort)
	api.HandleFunc("POST /api/sessions/{id}/model", s.passthrough("set_model", "provider", "modelId"))
	api.HandleFunc("POST /api/sessions/{id}/thinking", s.passthrough("set_thinking_level", "level"))
	api.HandleFunc("POST /api/sessions/{id}/name", s.passthrough("set_session_name", "name"))
	api.HandleFunc("GET /api/sessions/{id}/commands", s.passthrough("get_commands"))
	api.HandleFunc("POST /api/sessions/{id}/ui-response", s.handleUIResponse)
	api.HandleFunc("POST /api/sessions/{id}/release", s.handleRelease)
	api.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeErr(w, 404, "not_found", "no such endpoint") })

	mux := http.NewServeMux()
	mux.Handle("/api/", s.guard(api))
	mux.Handle("/", staticHandler(static))
	return logRequests(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "version": s.version, "pi": s.piVersion})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	data, err := s.hub.Models(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, "pi_error", err.Error())
		return
	}
	writeRaw(w, data)
}

type sessionOut struct {
	sessions.Info
	Status string `json:"status"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	list := s.hub.Idx.List()
	out := make([]sessionOut, 0, len(list))
	seen := map[string]bool{}
	for id, cwd := range s.hub.Known() { // started here, no file yet
		if _, ok := s.hub.Idx.Find(id); !ok && s.hub.Running(id) != nil {
			out = append(out, sessionOut{Info: sessions.Info{ID: id, Cwd: cwd, UpdatedAt: time.Now()}, Status: s.hub.Status(id)})
			seen[id] = true
		}
	}
	for _, info := range list {
		if !seen[info.ID] {
			out = append(out, sessionOut{Info: info, Status: s.hub.Status(info.ID)})
		}
	}
	writeJSON(w, 200, map[string]any{"sessions": out})
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd      string `json:"cwd"`
		Provider string `json:"provider"`
		ModelID  string `json:"modelId"`
		Thinking string `json:"thinking"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	cwd, ok := s.cfg.AllowedDir(body.Cwd)
	if !ok {
		writeErr(w, 400, "bad_cwd", "cwd 不在 PIMU_WORKDIRS 允许范围内或不存在")
		return
	}
	run, err := s.hub.Create(r.Context(), cwd)
	if err != nil {
		s.hubErr(w, err)
		return
	}
	if body.Provider != "" && body.ModelID != "" {
		if resp, err := s.hub.Call(r.Context(), run, map[string]any{"type": "set_model", "provider": body.Provider, "modelId": body.ModelID}, 30*time.Second); err != nil || !resp.Success {
			slog.Warn("set_model on create failed", "session", run.ID, "err", err, "pi", resp.Error)
		}
	}
	if body.Thinking != "" {
		_, _ = s.hub.Call(r.Context(), run, map[string]any{"type": "set_thinking_level", "level": body.Thinking}, 30*time.Second)
	}
	writeJSON(w, 200, map[string]string{"id": run.ID})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	out := map[string]any{"id": id, "status": s.hub.Status(id)}
	if info, ok := s.hub.Idx.Find(id); ok {
		out["path"], out["cwd"], out["name"], out["updatedAt"] = info.Path, info.Cwd, info.Name, info.UpdatedAt
	} else if cwd, ok := s.hub.Known()[id]; ok {
		out["cwd"] = cwd
	} else {
		writeErr(w, 404, "not_found", "会话不存在")
		return
	}
	if run := s.hub.Running(id); run != nil {
		if resp, err := s.hub.Call(r.Context(), run, map[string]any{"type": "get_state"}, 30*time.Second); err == nil && resp.Success {
			out["state"] = resp.Data
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	seq := s.hub.Stream(id).Seq() // events after seq are delivered by SSE
	if run := s.hub.Running(id); run != nil {
		resp, err := s.hub.Call(r.Context(), run, map[string]any{"type": "get_messages"}, 30*time.Second)
		if err == nil && resp.Success {
			var d struct {
				Messages json.RawMessage `json:"messages"`
			}
			_ = json.Unmarshal(resp.Data, &d)
			writeJSON(w, 200, map[string]any{"messages": d.Messages, "seq": seq, "live": true})
			return
		}
	}
	msgs := []json.RawMessage{}
	if info, ok := s.hub.Idx.Find(id); ok {
		m, err := sessions.Messages(info.Path)
		if err != nil {
			writeErr(w, 500, "read_error", err.Error())
			return
		}
		msgs = m
	} else if _, ok := s.hub.Known()[id]; !ok {
		writeErr(w, 404, "not_found", "会话不存在")
		return
	}
	writeJSON(w, 200, map[string]any{"messages": msgs, "seq": seq, "live": false})
}

func (s *Server) handlePrompt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Message  string          `json:"message"`
		Images   json.RawMessage `json:"images"`
		Behavior string          `json:"behavior"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Message) == "" {
		writeErr(w, 400, "empty", "消息为空")
		return
	}
	run, err := s.hub.Ensure(r.Context(), r.PathValue("id"))
	if err != nil {
		s.hubErr(w, err)
		return
	}
	cmd := map[string]any{"type": "prompt", "message": body.Message}
	if len(body.Images) > 0 && string(body.Images) != "null" {
		cmd["images"] = body.Images
	}
	if body.Behavior == "steer" || body.Behavior == "followUp" {
		cmd["streamingBehavior"] = body.Behavior
	} else if run.Streaming() {
		cmd["streamingBehavior"] = "followUp"
	}
	s.reply(w, r, run, cmd, 30*time.Second)
}

func (s *Server) handleAbort(w http.ResponseWriter, r *http.Request) {
	run := s.hub.Running(r.PathValue("id"))
	if run == nil {
		writeJSON(w, 200, map[string]any{"steering": []string{}, "followUp": []string{}})
		return
	}
	cleared, err := s.hub.Call(r.Context(), run, map[string]any{"type": "clear_queue"}, 30*time.Second)
	if err != nil {
		s.hubErr(w, err)
		return
	}
	if _, err := s.hub.Call(r.Context(), run, map[string]any{"type": "abort"}, 60*time.Second); err != nil {
		s.hubErr(w, err)
		return
	}
	writeRaw(w, cleared.Data)
}

// passthrough maps a request to one pi command, copying the named JSON fields.
func (s *Server) passthrough(piType string, fields ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cmd := map[string]any{"type": piType}
		if len(fields) > 0 {
			var body map[string]any
			if !readJSON(w, r, &body) {
				return
			}
			for _, f := range fields {
				if v, ok := body[f]; ok {
					cmd[f] = v
				}
			}
		}
		run, err := s.hub.Ensure(r.Context(), r.PathValue("id"))
		if err != nil {
			s.hubErr(w, err)
			return
		}
		s.reply(w, r, run, cmd, 30*time.Second)
	}
}

func (s *Server) reply(w http.ResponseWriter, r *http.Request, run *hub.Run, cmd map[string]any, timeout time.Duration) {
	resp, err := s.hub.Call(r.Context(), run, cmd, timeout)
	if err != nil {
		s.hubErr(w, err)
		return
	}
	if !resp.Success {
		writeErr(w, 400, "pi_rejected", resp.Error)
		return
	}
	writeRaw(w, resp.Data)
}

func (s *Server) handleUIResponse(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !readJSON(w, r, &body) {
		return
	}
	run := s.hub.Running(r.PathValue("id"))
	if run == nil {
		writeErr(w, 409, "not_running", "pi 进程已不在运行")
		return
	}
	msg := map[string]any{"type": "extension_ui_response"}
	for _, k := range []string{"id", "value", "confirmed", "cancelled"} {
		if v, ok := body[k]; ok {
			msg[k] = v
		}
	}
	if err := s.hub.Send(run, msg); err != nil {
		s.hubErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	s.hub.Release(r.Context(), r.PathValue("id"))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) hubErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, hub.ErrNotFound):
		writeErr(w, 404, "not_found", "会话不存在")
	case errors.Is(err, hub.ErrLocked):
		writeErr(w, 409, "locked", "终端 pi 正在使用此会话：在终端退出 pi 后重试")
	case errors.Is(err, hub.ErrTooMany):
		writeErr(w, 429, "too_many", "运行中的 pi 进程已达上限：先释放一个会话")
	case errors.Is(err, hub.ErrTimeout):
		writeErr(w, 504, "timeout", "pi 未在时限内响应")
	case errors.Is(err, pirpc.ErrExited), errors.Is(err, context.Canceled):
		writeErr(w, 502, "pi_exited", err.Error())
	default:
		writeErr(w, 502, "pi_error", err.Error())
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, 400, "bad_json", "请求体不是合法 JSON")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRaw(w http.ResponseWriter, data json.RawMessage) {
	if len(data) == 0 {
		data = json.RawMessage("{}")
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]string{"error": errCode, "message": msg})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(c int) { w.code = c; w.ResponseWriter.WriteHeader(c) }
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(sw, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			slog.Info("http", "method", r.Method, "path", r.URL.Path, "code", sw.code, "dur_ms", time.Since(start).Milliseconds())
		}
	})
}

func staticHandler(static fs.FS) http.Handler {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" || p == "index.html" || p == "sw.js" || p == "manifest.webmanifest" {
			w.Header().Set("Cache-Control", "no-cache")
		} else if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		if _, err := fs.Stat(static, p); p != "" && err != nil {
			r.URL.Path = "/" // hash routing: unknown paths get the app shell
		}
		files.ServeHTTP(w, r)
	})
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
