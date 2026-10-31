package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/0xNorex/pimu/internal/lock"
	"github.com/0xNorex/pimu/internal/sessions"
)

// ErrStreaming: the session is replying; try again when it settles.
var ErrStreaming = errors.New("session is streaming")

// BotSessionDir is where a bot's pi session files live (pi --session-dir):
// the current conversation (whose session id is the bot id) and its earlier
// topics (any other id). Tools run in the cwd pi records in each file header,
// independent of where the file is stored.
func (h *Hub) BotSessionDir(id string) string {
	return filepath.Join(h.cfg.DataDir, "bots", id, "session")
}

// MoveToBotDir moves bot id's own session file from pi's sessions dir into
// BotSessionDir (bots from before V14).
func (h *Hub) MoveToBotDir(id string) (bool, error) { return h.MoveInto(id, id) }

// MoveInto moves session id's file from pi's sessions dir into bot's
// session dir. The original is kept next to where it was as
// <name>.jsonl.pimu-moved (pi and Pimu ignore that suffix). No file, or
// already in a bots dir: nothing to do. A running idle process is stopped
// first (it restarts on the next message); a streaming one or a lock held by
// a pi in a terminal returns ErrStreaming / ErrLocked and leaves everything
// as it was.
func (h *Hub) MoveInto(bot, id string) (bool, error) {
	dir := h.BotSessionDir(bot)
	info, ok := h.Idx.Find(id)
	if !ok || h.InBotDir(info.Path) {
		return false, nil
	}
	unlock, err := h.hold(id)
	if err != nil {
		return false, err
	}
	defer unlock()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, err
	}
	dst := filepath.Join(dir, filepath.Base(info.Path))
	if err := copyFile(info.Path, dst); err != nil {
		return false, fmt.Errorf("copy session: %w", err)
	}
	if err := os.Rename(info.Path, info.Path+".pimu-moved"); err != nil {
		_ = os.Remove(dst) // keep exactly one live copy
		return false, fmt.Errorf("keep backup: %w", err)
	}
	slog.Info("session moved", "session", id, "to", dst)
	return true, nil
}

// InBotDir reports whether path is a session file under some bot's dir.
func (h *Hub) InBotDir(path string) bool {
	ok, _ := filepath.Match(filepath.Join(h.cfg.DataDir, "bots", "*", "session", "*"), path)
	return ok
}

// hold stops id's idle pi process and takes its session lock, which keeps
// Pimu and a terminal pi off the file. Streaming → ErrStreaming; a lock held
// elsewhere → ErrLocked.
func (h *Hub) hold(id string) (func(), error) {
	if r := h.Running(id); r != nil {
		if r.Streaming() {
			return nil, ErrStreaming
		}
		r.stop()
		select {
		case <-r.gone:
		case <-time.After(10 * time.Second):
			return nil, ErrLocked
		}
	}
	var err error
	for i := 0; i < 20; i++ { // a process that just exited drops its lock in watch()
		if err = lock.Acquire(h.cfg.AgentDir, id); !errors.Is(err, lock.ErrBusy) || h.Status(id) == "external" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if errors.Is(err, lock.ErrBusy) {
		return nil, ErrLocked
	}
	if err != nil {
		return nil, err
	}
	return func() { lock.Release(h.cfg.AgentDir, id) }, nil
}

// Topics lists bot's earlier conversations, newest first: every session file
// in its dir except the current one (session id = bot id).
func (h *Hub) Topics(bot string) []sessions.Info {
	dir := h.BotSessionDir(bot)
	out := []sessions.Info{}
	for _, i := range h.Idx.List() {
		if i.ID != bot && filepath.Dir(i.Path) == dir {
			out = append(out, i)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].UpdatedAt.After(out[b].UpdatedAt) })
	return out
}

// TopicOf reports the bot whose earlier topic id is (read-only until
// resumed).
func (h *Hub) TopicOf(id string) (string, bool) {
	info, ok := h.Idx.Find(id)
	if !ok || !h.InBotDir(info.Path) {
		return "", false
	}
	bot := filepath.Base(filepath.Dir(filepath.Dir(info.Path)))
	return bot, bot != id
}

// NewTopic archives bot's current conversation under a fresh session id; the
// next message starts a new pi session (empty context) with the bot's id.
// No conversation yet: nothing to do.
func (h *Hub) NewTopic(ctx context.Context, bot string) error {
	h.topicMu.Lock()
	defer h.topicMu.Unlock()
	return h.archive(bot)
}

// ResumeTopic makes topic the bot's current conversation again; the current
// one becomes a topic.
func (h *Hub) ResumeTopic(ctx context.Context, bot, topic string) error {
	h.topicMu.Lock()
	defer h.topicMu.Unlock()
	info, ok := h.Idx.Find(topic)
	if !ok || topic == bot || filepath.Dir(info.Path) != h.BotSessionDir(bot) {
		return ErrNotFound
	}
	unlockT, err := h.hold(topic)
	if err != nil {
		return err
	}
	defer unlockT()
	if err := h.archive(bot); err != nil {
		return err
	}
	if _, err := reID(info.Path, topic, bot); err != nil {
		return err
	}
	pimuEvent(h.Stream(bot), map[string]any{"type": "resync"}) // open chats reload
	return nil
}

// archive renames bot's current session file to a new id. Caller holds topicMu.
func (h *Hub) archive(bot string) error {
	info, ok := h.Idx.Find(bot)
	if !ok {
		return nil
	}
	if !h.InBotDir(info.Path) {
		return ErrLocked // still in pi's dir: the sweep moves it first
	}
	unlock, err := h.hold(bot)
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := reID(info.Path, bot, NewID()); err != nil {
		return err
	}
	pimuEvent(h.Stream(bot), map[string]any{"type": "resync"}) // open chats reload
	return nil
}

// reID rewrites the session id in path's header line (pi's "session"
// entry) and renames the file to match, keeping its mtime (list order). The
// new file is complete before the old one goes away.
func reID(path, from, to string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	nl := bytes.IndexByte(data, '\n')
	if nl < 0 {
		nl = len(data)
	}
	var head map[string]any
	if err := json.Unmarshal(data[:nl], &head); err != nil || head["type"] != "session" || head["id"] != from {
		return "", fmt.Errorf("%s: unexpected session header", filepath.Base(path))
	}
	line := bytes.Replace(data[:nl], []byte(`"id":"`+from+`"`), []byte(`"id":"`+to+`"`), 1)
	if bytes.Equal(line, data[:nl]) { // not pi's compact JSON: re-encode
		head["id"] = to
		if line, err = json.Marshal(head); err != nil {
			return "", err
		}
	}
	base := filepath.Base(path)
	if strings.Contains(base, from) {
		base = strings.Replace(base, from, to, 1)
	} else {
		base = strings.TrimSuffix(base, ".jsonl") + "_" + to + ".jsonl"
	}
	dst := filepath.Join(filepath.Dir(path), base)
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, append(line, data[nl:]...), 0o600); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	_ = os.Chtimes(tmp, st.ModTime(), st.ModTime())
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	slog.Info("session re-id", "from", from, "to", to)
	return dst, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, in)
	if err == nil && n != st.Size() {
		err = fmt.Errorf("short copy %d/%d", n, st.Size())
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		_ = os.Chtimes(tmp, st.ModTime(), st.ModTime()) // keep list order
		err = os.Rename(tmp, dst)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}
