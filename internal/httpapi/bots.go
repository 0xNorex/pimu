package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/sessions"
	"github.com/0xNorex/pimu/internal/store"
)

type botOut struct {
	store.Bot
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updatedAt"`
	Last      string    `json:"last,omitempty"`
	LastRole  string    `json:"lastRole,omitempty"`
	// JobsRunning is how many of the bot's background jobs are running now.
	JobsRunning int `json:"jobsRunning,omitempty"`
}

func (s *Server) botOut(b store.Bot, infos map[string]sessions.Info) botOut {
	out := botOut{Bot: b, Status: s.hub.Status(b.SessionID)}
	out.UpdatedAt, _ = time.Parse("2006-01-02T15:04:05.000Z", b.CreatedAt)
	if info, ok := infos[b.SessionID]; ok {
		out.UpdatedAt, out.Last, out.LastRole = info.UpdatedAt, info.Last, info.LastRole
	}
	return out
}

func (s *Server) infos() map[string]sessions.Info {
	m := map[string]sessions.Info{}
	for _, i := range s.hub.Idx.List() {
		m[i.ID] = i
	}
	return m
}

func (s *Server) handleBotList(w http.ResponseWriter, r *http.Request) {
	bots, err := s.st.Bots()
	if err != nil {
		s.storeErr(w, err)
		return
	}
	infos := s.infos()
	running, _ := s.st.RunningJobs() // best effort: the ring is cosmetic
	out := make([]botOut, 0, len(bots))
	for _, b := range bots {
		if b.Name == "" {
			continue // a draft: shown once its first message names it
		}
		o := s.botOut(b, infos)
		o.JobsRunning = running[b.SessionID]
		out = append(out, o)
	}
	writeJSON(w, 200, map[string]any{"bots": out})
}

func (s *Server) handleBotGet(w http.ResponseWriter, r *http.Request) {
	b, err := s.st.Bot(r.PathValue("id"))
	if err != nil {
		s.botErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"bot": s.botOut(b, s.infos())})
}

func (s *Server) botErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "not_found", "Bot 不存在")
		return
	}
	writeErr(w, 500, "db_error", err.Error())
}

func (s *Server) validBot(b *store.Bot) string {
	b.Name = strings.TrimSpace(b.Name)
	b.Description, b.Persona = strings.TrimSpace(b.Description), strings.TrimSpace(b.Persona)
	if len([]rune(b.Name)) > 40 || len([]rune(b.Description)) > 120 || len(b.Persona) > 16<<10 {
		return "名字 ≤40 字、简介 ≤120 字、人设 ≤16 KB"
	}
	cwd, ok := s.cfg.AllowedDir(b.Cwd)
	if !ok {
		return s.cwdErr(b.Cwd)
	}
	b.Cwd = cwd
	return ""
}

// handleBotCreate makes a new bot: a fresh pi session id, started lazily on
// the first message. Everything is optional: a bot without a name is a draft
// ('+' in the UI), hidden from the list until its first message names it
// (autoTitle) and removed by the sweep if it never gets one. The cwd defaults
// to the first workdir.
func (s *Server) handleBotCreate(w http.ResponseWriter, r *http.Request) {
	var b store.Bot
	if !readJSON(w, r, &b) {
		return
	}
	b.SessionID = hub.NewID()
	if b.Cwd == "" && len(s.cfg.Workdirs) > 0 {
		b.Cwd = s.cfg.Workdirs[0]
	}
	if msg := s.validBot(&b); msg != "" {
		writeErr(w, 400, "invalid", msg)
		return
	}
	b.Archived = false
	b, err := s.st.CreateBot(b)
	if err != nil {
		s.botErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"bot": s.botOut(b, s.infos())})
}

// handleBotPatch overlays the body. A new name reaches pi now if it is running
// (set_session_name), else via --name on next start. A new persona applies on
// the next pi start, so an idle process is released; so does the safety mode
// (a running turn keeps its mode until the process restarts).
func (s *Server) handleBotPatch(w http.ResponseWriter, r *http.Request) {
	old, err := s.st.Bot(r.PathValue("id"))
	if err != nil {
		s.botErr(w, err)
		return
	}
	b := old
	if !readJSON(w, r, &b) {
		return
	}
	b.SessionID = old.SessionID
	if b.Name = strings.TrimSpace(b.Name); b.Name == "" && old.Name != "" {
		writeErr(w, 400, "invalid", "名字不能为空")
		return
	}
	if b.SessionID == store.AssistantID && b.Archived {
		writeErr(w, 400, "invalid", "默认助手不能归档")
		return
	}
	if msg := s.validBot(&b); msg != "" {
		writeErr(w, 400, "invalid", msg)
		return
	}
	if b, err = s.st.UpdateBot(b); err != nil {
		s.botErr(w, err)
		return
	}
	if run := s.hub.Running(b.SessionID); run != nil {
		if b.Name != old.Name {
			_, _ = s.hub.Call(r.Context(), run, map[string]any{"type": "set_session_name", "name": b.Name}, 30*time.Second)
		}
		if (b.Persona != old.Persona || b.Cwd != old.Cwd || b.Mode != old.Mode) && !run.Streaming() {
			s.hub.Release(r.Context(), b.SessionID)
		}
	}
	writeJSON(w, 200, map[string]any{"bot": s.botOut(b, s.infos())})
}

const uploadMax = 25 << 20

var unsafeName = regexp.MustCompile(`[^\p{L}\p{N}._-]+`)

// handleUpload stores one file under <cwd>/.pimu/uploads/<session>/ and
// returns its absolute path; the client mentions the path in the prompt and
// pi reads it with its own tools.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cwd := ""
	if b, err := s.st.Bot(id); err == nil {
		cwd = b.Cwd
	} else if info, ok := s.hub.Idx.Find(id); ok {
		cwd = info.Cwd
	} else if c, ok := s.known(id); ok {
		cwd = c
	} else {
		writeErr(w, 404, "not_found", "会话不存在")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, uploadMax+1<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 413, "too_large", "文件读取失败或超过 25 MB")
		return
	}
	defer f.Close()
	name := strings.Trim(unsafeName.ReplaceAllString(filepath.Base(hdr.Filename), "_"), "._")
	if name == "" {
		name = "file"
	}
	if len(name) > 100 {
		name = name[len(name)-100:]
	}
	dir := filepath.Join(cwd, ".pimu", "uploads", id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	path := filepath.Join(dir, time.Now().Format("0102-150405")+"-"+name)
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	n, err := io.Copy(out, io.LimitReader(f, uploadMax+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > uploadMax {
		err = fmt.Errorf("文件超过 25 MB")
	}
	if err != nil {
		os.Remove(path)
		writeErr(w, 413, "too_large", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"path": path, "name": hdr.Filename, "size": n})
}

type topicOut struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Cwd       string    `json:"cwd"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// handleTopicList lists the bot's earlier conversations (详情 → 历史).
func (s *Server) handleTopicList(w http.ResponseWriter, r *http.Request) {
	b, err := s.st.Bot(r.PathValue("id"))
	if err != nil {
		s.botErr(w, err)
		return
	}
	out := []topicOut{}
	for _, i := range s.hub.Topics(b.SessionID) {
		title := strings.TrimSpace(i.Preview)
		if title == "" || (i.Name != "" && i.Name != b.Name) {
			title = firstNonEmpty(i.Name, title, "（空对话）")
		}
		if r := []rune(title); len(r) > 60 {
			title = string(r[:60]) + "…"
		}
		out = append(out, topicOut{ID: i.ID, Title: title, Cwd: i.Cwd, UpdatedAt: i.UpdatedAt})
	}
	writeJSON(w, 200, map[string]any{"topics": out})
}

// handleTopicNew starts a new topic: the current conversation moves to the
// history and the next message starts a fresh pi session (empty context).
func (s *Server) handleTopicNew(w http.ResponseWriter, r *http.Request) {
	b, err := s.st.Bot(r.PathValue("id"))
	if err != nil {
		s.botErr(w, err)
		return
	}
	s.topicResult(w, s.hub.NewTopic(r.Context(), b.SessionID))
}

// handleTopicResume makes an earlier topic current again (继续这个话题).
func (s *Server) handleTopicResume(w http.ResponseWriter, r *http.Request) {
	b, err := s.st.Bot(r.PathValue("id"))
	if err != nil {
		s.botErr(w, err)
		return
	}
	s.topicResult(w, s.hub.ResumeTopic(r.Context(), b.SessionID, r.PathValue("topic")))
}

func (s *Server) topicResult(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		writeJSON(w, 200, map[string]bool{"ok": true})
	case errors.Is(err, hub.ErrStreaming):
		writeErr(w, 409, "busy", "它还在回复，等这一轮结束再换话题")
	case errors.Is(err, hub.ErrLocked):
		writeErr(w, 409, "locked", "这个对话正在终端里打开，先在终端退出 pi")
	case errors.Is(err, hub.ErrNotFound):
		writeErr(w, 404, "not_found", "话题不存在")
	default:
		writeErr(w, 500, "io_error", err.Error())
	}
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
