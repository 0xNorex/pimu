// Package sessions reads pi session JSONL files. It never writes them.
package sessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxLine = 16 << 20

type Info struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Cwd       string    `json:"cwd"`
	Name      string    `json:"name,omitempty"`
	Preview   string    `json:"preview,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type cached struct {
	mod  time.Time
	size int64
	info Info
}

// Index scans a session directory, caching parsed headers by mtime+size.
type Index struct {
	dir   string
	mu    sync.Mutex
	cache map[string]cached
}

func NewIndex(dir string) *Index { return &Index{dir: dir, cache: map[string]cached{}} }

// List returns all sessions, newest first.
func (x *Index) List() []Info {
	paths, _ := filepath.Glob(filepath.Join(x.dir, "*", "*.jsonl"))
	x.mu.Lock()
	defer x.mu.Unlock()
	seen := map[string]bool{}
	out := make([]Info, 0, len(paths))
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		seen[p] = true
		c, ok := x.cache[p]
		if !ok || !c.mod.Equal(st.ModTime()) || c.size != st.Size() {
			info, err := parseInfo(p)
			if err != nil {
				slog.Warn("session parse", "path", p, "err", err)
				continue
			}
			c = cached{mod: st.ModTime(), size: st.Size(), info: info}
			x.cache[p] = c
		}
		c.info.UpdatedAt = st.ModTime()
		out = append(out, c.info)
	}
	for p := range x.cache {
		if !seen[p] {
			delete(x.cache, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

// Find returns the session with id, if a file for it exists.
func (x *Index) Find(id string) (Info, bool) {
	for _, s := range x.List() {
		if s.ID == id {
			return s, true
		}
	}
	return Info{}, false
}

type entry struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	ParentID *string         `json:"parentId"`
	Cwd      string          `json:"cwd"`
	Name     *string         `json:"name"`
	Message  json.RawMessage `json:"message"`
}

type message struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func eachLine(path string, fn func([]byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := r.ReadBytes('\n')
		line = bytes.TrimRight(line, "\r\n")
		if len(line) > maxLine {
			slog.Warn("session line too long, skipped", "path", path, "bytes", len(line))
		} else if len(line) > 0 {
			fn(line)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func parseInfo(path string) (Info, error) {
	info := Info{Path: path}
	first := true
	err := eachLine(path, func(line []byte) {
		var e entry
		if json.Unmarshal(line, &e) != nil {
			return
		}
		if first {
			first = false
			if e.Type == "session" {
				info.ID, info.Cwd = e.ID, e.Cwd
			}
			return
		}
		switch e.Type {
		case "session_info":
			if e.Name != nil {
				info.Name = *e.Name
			}
		case "message":
			if info.Preview == "" {
				var m message
				if json.Unmarshal(e.Message, &m) == nil && m.Role == "user" {
					info.Preview = truncate(text(m.Content), 80)
				}
			}
		}
	})
	if err == nil && info.ID == "" {
		err = os.ErrInvalid
	}
	return info, err
}

// text extracts plain text from string or content-block message content.
func text(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &blocks)
	var b strings.Builder
	for _, bl := range blocks {
		if bl.Type == "text" {
			b.WriteString(bl.Text)
		}
	}
	return b.String()
}

func truncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// Messages returns the messages on the current branch: the last entry is
// taken as the leaf and parentId links are followed back to the root.
func Messages(path string) ([]json.RawMessage, error) {
	byID := map[string]entry{}
	var leaf string
	err := eachLine(path, func(line []byte) {
		var e entry
		if json.Unmarshal(line, &e) != nil || e.ID == "" || e.Type == "session" {
			return
		}
		byID[e.ID] = e
		leaf = e.ID
	})
	if err != nil {
		return nil, err
	}
	var out []json.RawMessage
	for id := leaf; id != ""; {
		e, ok := byID[id]
		if !ok {
			break
		}
		delete(byID, id) // guards against cycles
		if e.Type == "message" {
			var m message
			if json.Unmarshal(e.Message, &m) == nil && (m.Role == "user" || m.Role == "assistant" || m.Role == "toolResult") {
				out = append(out, e.Message)
			}
		}
		id = ""
		if e.ParentID != nil {
			id = *e.ParentID
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// Meta is the model and thinking level recorded in a session file, so an
// idle session's header can show them without starting pi.
type Meta struct {
	Model         *MetaModel `json:"model,omitempty"`
	ThinkingLevel string     `json:"thinkingLevel,omitempty"`
}

type MetaModel struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

func ReadMeta(path string) Meta {
	var m Meta
	_ = eachLine(path, func(line []byte) {
		var e struct {
			Type          string `json:"type"`
			Provider      string `json:"provider"`
			ModelID       string `json:"modelId"`
			ThinkingLevel string `json:"thinkingLevel"`
		}
		if json.Unmarshal(line, &e) != nil {
			return
		}
		switch e.Type {
		case "model_change":
			m.Model = &MetaModel{Provider: e.Provider, ID: e.ModelID}
		case "thinking_level_change":
			m.ThinkingLevel = e.ThinkingLevel
		}
	})
	return m
}
