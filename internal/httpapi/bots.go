package httpapi

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
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
	out := make([]botOut, 0, len(bots))
	for _, b := range bots {
		out = append(out, s.botOut(b, infos))
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
	if b.Name == "" {
		return "名字不能为空"
	}
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

// handleBotCreate makes a new bot (every field optional) (a fresh pi session id, started lazily on
// the first message) or adopts an existing session when sessionId is given.
func (s *Server) handleBotCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		store.Bot
		Adopt string `json:"sessionId"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	b := body.Bot
	b.SessionID = hub.NewID()
	if body.Adopt != "" {
		info, ok := s.hub.Idx.Find(body.Adopt)
		if !ok { // a new Pimu session that has no file yet
			cwd, known := s.hub.Known()[body.Adopt]
			if !known {
				writeErr(w, 404, "not_found", "会话不存在")
				return
			}
			info.ID, info.Cwd = body.Adopt, cwd
		}
		b.SessionID, b.Cwd = info.ID, info.Cwd
		if strings.TrimSpace(b.Name) == "" { // default: the session's title or first message
			b.Name = strings.TrimSpace(clipRunes(firstNonEmpty(info.Name, info.Preview), 20))
		}
	}
	if strings.TrimSpace(b.Name) == "" { // nothing to fill in: auto-name
		n := 1
		if all, err := s.st.Bots(); err == nil {
			n = len(all) + 1
		}
		b.Name = fmt.Sprintf("助手 %d", n)
	}
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
	// Into the bots dir now if idle; a busy session is moved by the periodic sweep.
	if _, err := s.hub.MoveToBotDir(b.SessionID); err != nil {
		slog.Info("bot session not moved yet", "session", b.SessionID, "err", err)
	}
	writeJSON(w, 200, map[string]any{"bot": s.botOut(b, s.infos())})
}

// handleBotDelete unsets a bot: the pi session and its files stay, only the
// bot metadata (name, persona, goals) is dropped.
func (s *Server) handleBotDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.st.DeleteBot(id); err != nil {
		s.botErr(w, err)
		return
	}
	if run := s.hub.Running(id); run != nil && !run.Streaming() {
		s.hub.Release(r.Context(), id) // drop the persona on next start
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
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
	} else if c, ok := s.hub.Known()[id]; ok {
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
