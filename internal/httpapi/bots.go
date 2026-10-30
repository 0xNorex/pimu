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
	b.Name, b.Emoji = strings.TrimSpace(b.Name), strings.TrimSpace(b.Emoji)
	b.Description, b.Persona = strings.TrimSpace(b.Description), strings.TrimSpace(b.Persona)
	if b.Name == "" {
		return "名字不能为空"
	}
	if b.Emoji == "" {
		b.Emoji = "🤖"
	}
	if len([]rune(b.Name)) > 40 || len([]rune(b.Emoji)) > 8 || len([]rune(b.Description)) > 120 || len(b.Persona) > 16<<10 {
		return "名字 ≤40 字、头像 ≤8 字符、简介 ≤120 字、人设 ≤16 KB"
	}
	cwd, ok := s.cfg.AllowedDir(b.Cwd)
	if !ok {
		return "工作目录不在 PIMU_WORKDIRS 允许范围内或不存在"
	}
	b.Cwd = cwd
	return ""
}

// handleBotCreate makes a new bot (a fresh pi session id, started lazily on
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
		if !ok {
			writeErr(w, 404, "not_found", "会话不存在")
			return
		}
		b.SessionID, b.Cwd = info.ID, info.Cwd
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
	writeJSON(w, 200, map[string]any{"bot": s.botOut(b, s.infos())})
}

// handleBotPatch overlays the body. A new name reaches pi now if it is running
// (set_session_name), else via --name on next start. A new persona applies on
// the next pi start, so an idle process is released.
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
		if (b.Persona != old.Persona || b.Cwd != old.Cwd) && !run.Streaming() {
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
