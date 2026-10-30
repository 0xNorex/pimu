package hub

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/0xNorex/pimu/internal/lock"
)

// ErrStreaming: the session is replying; try again when it settles.
var ErrStreaming = errors.New("session is streaming")

// BotSessionDir is where a bot's pi session file lives (pi --session-dir).
// The bot's working directory for tools stays bot.Cwd; pi records it in the
// file header, independent of where the file is stored.
func (h *Hub) BotSessionDir(id string) string {
	return filepath.Join(h.cfg.DataDir, "bots", id, "session")
}

// MoveToBotDir moves id's session file from pi's sessions dir into
// BotSessionDir. The original is kept next to where it was as
// <name>.jsonl.pimu-moved (pi and Pimu ignore that suffix). No file yet,
// already moved: nothing to do. A running idle process is stopped first (it
// restarts on the next message); a streaming one or a lock held by a pi in a
// terminal returns ErrStreaming / ErrLocked and leaves everything as it was.
func (h *Hub) MoveToBotDir(id string) (bool, error) {
	dir := h.BotSessionDir(id)
	info, ok := h.Idx.Find(id)
	if !ok || filepath.Dir(info.Path) == dir {
		return false, nil
	}
	if r := h.Running(id); r != nil {
		if r.Streaming() {
			return false, ErrStreaming
		}
		r.proc.Close()
		select {
		case <-r.proc.Done():
		case <-time.After(10 * time.Second):
			return false, ErrLocked
		}
	}
	// Holding the lock keeps Pimu and a terminal pi off the file while it moves.
	// A process that just exited drops its lock in watch(), hence the retries.
	var err error
	for i := 0; i < 20; i++ {
		if err = lock.Acquire(h.cfg.AgentDir, id); !errors.Is(err, lock.ErrBusy) || h.Status(id) == "external" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if errors.Is(err, lock.ErrBusy) {
		return false, ErrLocked
	}
	if err != nil {
		return false, err
	}
	defer lock.Release(h.cfg.AgentDir, id)
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
	slog.Info("bot session moved", "session", id, "to", dst)
	return true, nil
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
