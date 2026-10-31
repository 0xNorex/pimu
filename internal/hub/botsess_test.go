package hub

import (
	"context"
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

func TestNewTopicAndResume(t *testing.T) {
	tmp := t.TempDir()
	cfg := &config.Config{PiBin: os.Args[0], AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "sessions"), DataDir: filepath.Join(tmp, "data"), MaxProcs: 2, IdleTimeout: time.Minute}
	h := New(cfg)
	dir := h.BotSessionDir("pm-bot")
	os.MkdirAll(dir, 0o700)
	cur := filepath.Join(dir, "2026-01-01T00-00-00_pm-bot.jsonl")
	body := `{"type":"session","version":3,"id":"pm-bot","cwd":"/work"}` + "\n" + `{"type":"message","message":{"role":"user","content":"first topic"}}` + "\n"
	os.WriteFile(cur, []byte(body), 0o600)

	if err := h.NewTopic(context.Background(), "pm-bot"); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.Idx.Find("pm-bot"); ok {
		t.Fatal("current conversation still there")
	}
	tops := h.Topics("pm-bot")
	if len(tops) != 1 || tops[0].Preview != "first topic" || tops[0].Cwd != "/work" || !h.IsTopic(tops[0].ID) {
		t.Fatalf("topics: %+v", tops)
	}
	old := tops[0].ID
	if err := h.NewTopic(context.Background(), "pm-bot"); err != nil { // nothing to archive
		t.Fatal(err)
	}

	// A second conversation, then resume the first.
	os.WriteFile(filepath.Join(dir, "2026-01-02T00-00-00_pm-bot.jsonl"), []byte(`{"type":"session","version":3,"id":"pm-bot","cwd":"/work"}`+"\n"+`{"type":"message","message":{"role":"user","content":"second"}}`+"\n"), 0o600)
	if err := h.ResumeTopic(context.Background(), "pm-bot", old); err != nil {
		t.Fatal(err)
	}
	if s, ok := h.Idx.Find("pm-bot"); !ok || s.Preview != "first topic" || h.IsTopic("pm-bot") {
		t.Fatalf("resumed: %+v %v", s, ok)
	}
	if b, _ := os.ReadFile(cur); string(b) != body {
		t.Fatalf("resumed file differs: %q", b)
	}
	if tops := h.Topics("pm-bot"); len(tops) != 1 || tops[0].Preview != "second" {
		t.Fatalf("after resume: %+v", tops)
	}
	if err := h.ResumeTopic(context.Background(), "pm-bot", "pm-nope"); err != ErrNotFound {
		t.Fatalf("unknown topic: %v", err)
	}
}
