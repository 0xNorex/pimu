package hub

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/lock"
)

func TestMoveToBotDirKeepsHistoryAndBackup(t *testing.T) {
	tmp := t.TempDir()
	cfg := &config.Config{PiBin: os.Args[0], AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "sessions"), DataDir: filepath.Join(tmp, "data"), MaxProcs: 2, IdleTimeout: time.Minute}
	h := New(cfg)
	sub := filepath.Join(cfg.SessionDir, "--work--")
	os.MkdirAll(sub, 0o700)
	orig := filepath.Join(sub, "2026-01-01T00-00-00_pm-b1.jsonl")
	body := `{"type":"session","id":"pm-b1","cwd":"/work"}` + "\n" + `{"type":"message","message":{"role":"user","content":"hi"}}` + "\n"
	os.WriteFile(orig, []byte(body), 0o600)

	// A terminal pi holding the lock: leave everything where it is.
	lp := lock.Path(cfg.AgentDir, "pm-b1")
	os.MkdirAll(filepath.Dir(lp), 0o700)
	os.WriteFile(lp, []byte(`{"pid":1,"owner":"pi-cli"}`), 0o600)
	if moved, err := h.MoveToBotDir("pm-b1"); moved || err == nil {
		t.Fatalf("moved a locked session: %v %v", moved, err)
	}
	os.Remove(lp)

	moved, err := h.MoveToBotDir("pm-b1")
	if err != nil || !moved {
		t.Fatalf("move: %v %v", moved, err)
	}
	dst := filepath.Join(h.BotSessionDir("pm-b1"), filepath.Base(orig))
	if b, _ := os.ReadFile(dst); string(b) != body {
		t.Fatalf("history lost: %q", b)
	}
	if b, _ := os.ReadFile(orig + ".pimu-moved"); string(b) != body {
		t.Fatal("no backup")
	}
	if _, err := os.Stat(orig); !os.IsNotExist(err) {
		t.Fatal("original still live")
	}
	if s, ok := h.Idx.Find("pm-b1"); !ok || s.Path != dst || s.Cwd != "/work" {
		t.Fatalf("index: %+v %v", s, ok)
	}
	n := 0
	for _, s := range h.Idx.List() {
		if s.ID == "pm-b1" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("listed %d times", n)
	}
	if moved, err := h.MoveToBotDir("pm-b1"); moved || err != nil {
		t.Fatalf("second move: %v %v", moved, err)
	}
}
