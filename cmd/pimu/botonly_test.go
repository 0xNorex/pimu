package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/lock"
	"github.com/0xNorex/pimu/internal/store"
)

func TestAssistantAndPlainMigration(t *testing.T) {
	tmp := t.TempDir()
	cfg := &config.Config{PiBin: os.Args[0], AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "sessions"), DataDir: filepath.Join(tmp, "data"), MaxProcs: 2, IdleTimeout: time.Minute, Workdirs: []string{"/work"}}
	os.MkdirAll(cfg.DataDir, 0o700)
	st, err := store.Open(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sub := filepath.Join(cfg.SessionDir, "--other--")
	os.MkdirAll(sub, 0o700)
	write := func(id, cwd string) string {
		p := filepath.Join(sub, "2026-01-01T00-00-00_"+id+".jsonl")
		os.WriteFile(p, []byte(`{"type":"session","id":"`+id+`","cwd":"`+cwd+`"}`+"\n"+`{"type":"message","message":{"role":"user","content":"q `+id+`"}}`+"\n"), 0o600)
		return p
	}
	plain, busyOne := write("pm-p1", "/other"), write("pm-p2", "/other")
	write("pimu-j7", "/work") // a background job stays
	lp := lock.Path(cfg.AgentDir, "pm-p2")
	os.MkdirAll(filepath.Dir(lp), 0o700)
	os.WriteFile(lp, []byte(`{"pid":1,"owner":"pi-cli"}`), 0o600) // open in a terminal

	h := hub.New(cfg)
	for i := 0; i < 2; i++ { // idempotent
		if err := ensureAssistant(st, cfg); err != nil {
			t.Fatal(err)
		}
	}
	if b, err := st.Bot(store.AssistantID); err != nil || b.Name != "助手" || b.Cwd != "/work" {
		t.Fatalf("assistant: %+v %v", b, err)
	}
	if err := planMigration(cfg, st, h); err != nil {
		t.Fatal(err)
	}
	migratePlain(cfg, h)
	tops := h.Topics(store.AssistantID)
	if len(tops) != 1 || tops[0].ID != "pm-p1" || tops[0].Cwd != "/other" {
		t.Fatalf("topics: %+v", tops)
	}
	if _, err := os.Stat(plain + ".pimu-moved"); err != nil {
		t.Fatal("no backup")
	}
	if _, err := os.Stat(busyOne); err != nil {
		t.Fatal("moved a locked session")
	}
	os.Remove(lp)
	write("pm-p3", "/later")                          // created after the plan: left alone
	if err := planMigration(cfg, st, h); err != nil { // second start: plan kept
		t.Fatal(err)
	}
	migratePlain(cfg, h)
	if n := len(h.Topics(store.AssistantID)); n != 2 {
		t.Fatalf("retry: %d topics", n)
	}
	if _, ok := h.Idx.Find("pimu-j7"); !ok {
		t.Fatal("job session gone")
	}
	if i, _ := h.Idx.Find("pm-p3"); h.InBotDir(i.Path) {
		t.Fatal("later session moved")
	}
}
