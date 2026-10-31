// Package httpapi serves the JSON API, the SSE event stream and the
// embedded web UI.
package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/0xNorex/pimu/internal/caps"
	"github.com/0xNorex/pimu/internal/cfaccess"
	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/goals"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/jobs"
	"github.com/0xNorex/pimu/internal/pirpc"
	"github.com/0xNorex/pimu/internal/sessions"
	"github.com/0xNorex/pimu/internal/store"
	"github.com/0xNorex/pimu/internal/tasks"
)

type Server struct {
	cfg       *config.Config
	hub       *hub.Hub
	st        *store.Store
	tasks     *tasks.Service
	goals     *goals.Service
	jobs      *jobs.Service
	Caps      *caps.Registry // pi process capabilities for /api/internal/*
	version   string
	piVersion string
	limiter   *limiter
	access    *cfaccess.Verifier // nil: Cloudflare Access checks off
}

func New(cfg *config.Config, h *hub.Hub, st *store.Store, tk *tasks.Service, gs *goals.Service, js *jobs.Service, version, piVersion string) *Server {
	s := &Server{cfg: cfg, hub: h, st: st, tasks: tk, goals: gs, jobs: js, version: version, piVersion: piVersion, limiter: &limiter{hits: map[string][]time.Time{}}}
	if cfg.CFAccessTeam != "" {
		s.access = cfaccess.New(cfg.CFAccessTeam, cfg.CFAccessAUD, cfg.CFAccessEmails)
	}
	return s
}

func (s *Server) Handler(static fs.FS) http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/health", s.handleHealth)
	api.HandleFunc("POST /api/login", s.handleLogin)
	api.HandleFunc("POST /api/logout", s.handleLogout)
	api.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	api.HandleFunc("GET /api/workdirs", func(w http.ResponseWriter, r *http.Request) {
		home, _ := os.UserHomeDir()
		writeJSON(w, 200, map[string]any{"workdirs": s.cfg.Workdirs, "home": home})
	})
	api.HandleFunc("GET /api/dirs", s.handleDirs)
	api.HandleFunc("POST /api/dirs", s.handleMkdir)
	api.HandleFunc("GET /api/models", s.handleModels)
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
	api.HandleFunc("GET /api/bots", s.handleBotList)
	api.HandleFunc("POST /api/bots", s.handleBotCreate)
	api.HandleFunc("GET /api/bots/{id}", s.handleBotGet)
	api.HandleFunc("PATCH /api/bots/{id}", s.handleBotPatch)
	api.HandleFunc("GET /api/bots/{id}/topics", s.handleTopicList)
	api.HandleFunc("POST /api/bots/{id}/topics", s.handleTopicNew)
	api.HandleFunc("POST /api/bots/{id}/topics/{topic}/resume", s.handleTopicResume)
	api.HandleFunc("POST /api/sessions/{id}/files", s.handleUpload)
	api.HandleFunc("GET /api/events", s.handleGlobalEvents)
	api.HandleFunc("GET /api/tasks", s.handleTaskList)
	api.HandleFunc("POST /api/tasks", s.handleTaskCreate)
	api.HandleFunc("GET /api/tasks/{id}", s.handleTaskGet)
	api.HandleFunc("PATCH /api/tasks/{id}", s.handleTaskPatch)
	api.HandleFunc("DELETE /api/tasks/{id}", s.handleTaskDelete)
	api.HandleFunc("POST /api/tasks/{id}/run", s.handleTaskRun)
	api.HandleFunc("GET /api/runs", s.handleRuns)
	api.HandleFunc("GET /api/memory", s.handleMemoryGet)
	api.HandleFunc("PUT /api/memory", s.handleMemoryPut)
	api.HandleFunc("GET /api/prefs", s.handlePrefsGet)
	api.HandleFunc("PUT /api/prefs", s.handlePrefsPut)
	api.HandleFunc("GET /api/settings", s.handleSettingsGet)
	api.HandleFunc("PATCH /api/settings/model", s.handleSettingsModel)
	api.HandleFunc("PATCH /api/settings/extension", s.handleSettingsExtension)
	api.HandleFunc("PATCH /api/settings/mcp/{name}", s.handleSettingsMCP)
	api.HandleFunc("GET /api/settings/mcp/status", s.handleMCPStatus)
	api.HandleFunc("GET /api/settings/commands", s.handleSettingsCommands)
	api.HandleFunc("GET /api/settings/skill", s.handleSettingsSkill)
	api.HandleFunc("GET /api/bots/{id}/goals", s.handleGoalList)
	api.HandleFunc("POST /api/bots/{id}/goals", s.handleGoalCreate)
	api.HandleFunc("GET /api/goals", s.handleGoalAll)
	api.HandleFunc("GET /api/goals/{id}", s.handleGoalGet)
	api.HandleFunc("PATCH /api/goals/{id}", s.handleGoalPatch)
	api.HandleFunc("DELETE /api/goals/{id}", s.handleGoalDelete)
	api.HandleFunc("POST /api/goals/{id}/beat", s.handleGoalBeat)
	api.HandleFunc("POST /api/goals/{id}/hook", s.handleGoalHook) // no login: ?k=<hook secret>
	api.HandleFunc("GET /api/inbox", s.handleInbox)
	api.HandleFunc("GET /api/inbox/count", s.handleInboxCount)
	api.HandleFunc("POST /api/inbox/read-all", s.handleInboxReadAll)
	api.HandleFunc("POST /api/inbox/{id}", s.handleInboxDecide)
	api.HandleFunc("POST /api/internal/approvals", s.handleApprovalRequest) // pimu-agent.ts, capability token
	api.HandleFunc("POST /api/internal/approvals/{id}/status", s.handleApprovalStatus)
	api.HandleFunc("POST /api/internal/jobs", s.handleJobDelegate)
	api.HandleFunc("GET /api/bots/{id}/jobs", s.handleJobList)
	api.HandleFunc("GET /api/jobs/{id}", s.handleJobGet)
	api.HandleFunc("POST /api/jobs/{id}/{action}", s.handleJobAction) // cancel | steer | rerun
	api.HandleFunc("POST /api/sessions/{id}/compact", s.passthroughT("compact", 10*time.Minute, "customInstructions"))
	api.HandleFunc("GET /api/sessions/{id}/stats", s.passthrough("get_session_stats"))
	api.HandleFunc("POST /api/sessions/{id}/export", s.passthroughT("export_html", 2*time.Minute))
	api.HandleFunc("GET /api/sessions/{id}/last-text", s.passthrough("get_last_assistant_text"))
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

// known: a session that has no file yet — a task run started here, or a bot
// before its first message (also right after 新话题). The cwd is where it
// starts.
func (s *Server) known(id string) (string, bool) {
	if cwd, ok := s.hub.Known()[id]; ok {
		return cwd, true
	}
	if b, err := s.st.Bot(id); err == nil {
		return b.Cwd, true
	}
	return "", false
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	out := map[string]any{"id": id, "status": s.hub.Status(id)}
	if info, ok := s.hub.Idx.Find(id); ok {
		out["path"], out["cwd"], out["name"], out["updatedAt"] = info.Path, info.Cwd, info.Name, info.UpdatedAt
	} else if cwd, ok := s.known(id); ok {
		out["cwd"] = cwd
	} else {
		writeErr(w, 404, "not_found", "会话不存在")
		return
	}
	if run := s.hub.Running(id); run != nil {
		if resp, err := s.hub.Call(r.Context(), run, map[string]any{"type": "get_state"}, 30*time.Second); err == nil && resp.Success {
			out["state"] = resp.Data
		}
	} else if info, ok := s.hub.Idx.Find(id); ok {
		out["state"] = sessions.ReadMeta(info.Path) // idle: model/thinking from the file
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
			var live []json.RawMessage
			if json.Unmarshal(d.Messages, &live) == nil {
				if info, ok := s.hub.Idx.Find(id); ok && bytes.Contains(d.Messages, []byte(`"compactionSummary"`)) {
					if file, err := sessions.Messages(info.Path); err == nil {
						live = sessions.MergeCompacted(live, file)
					}
				}
				writeJSON(w, 200, map[string]any{"messages": live, "seq": seq, "live": true})
				return
			}
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
	} else if _, ok := s.known(id); !ok {
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
	if s.hub.IsTopic(r.PathValue("id")) {
		writeErr(w, 409, "topic", "这是以前的话题，先点「继续这个话题」")
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
	return s.passthroughT(piType, 30*time.Second, fields...)
}

// passthroughT is passthrough with a custom timeout (compact can take minutes).
func (s *Server) passthroughT(piType string, timeout time.Duration, fields ...string) http.HandlerFunc {
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
		s.reply(w, r, run, cmd, timeout)
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
		if gz := zipped(static, p); gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(p)))
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			_, _ = w.Write(gz)
			return
		}
		if _, err := fs.Stat(static, p); p != "" && err != nil {
			r.URL.Path = "/" // hash routing: unknown paths get the app shell
		}
		files.ServeHTTP(w, r)
	})
}

var (
	gzMu    sync.Mutex
	gzCache = map[string][]byte{}
)

// zipped returns the gzipped bytes of a hashed JS/CSS asset (compressed once,
// they never change), or nil for anything else. Saves ~70% on a phone's first load.
func zipped(static fs.FS, p string) []byte {
	if !strings.HasPrefix(p, "assets/") || (!strings.HasSuffix(p, ".js") && !strings.HasSuffix(p, ".css")) {
		return nil
	}
	gzMu.Lock()
	defer gzMu.Unlock()
	if b, ok := gzCache[p]; ok {
		return b
	}
	raw, err := fs.ReadFile(static, p)
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	gzCache[p] = buf.Bytes()
	return gzCache[p]
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
