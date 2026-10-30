package jobs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/fakepi"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/store"
)

func TestMain(m *testing.M) {
	fakepi.Run()
	os.Exit(m.Run())
}

type env struct {
	st  *store.Store
	h   *hub.Hub
	js  *Service
	bot string
}

func setup(t *testing.T, max int, prestart func(*store.Store, string)) *env {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("FAKEPI", "1")
	st, err := store.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.CreateBot(store.Bot{SessionID: "pm-bot", Name: "bot", Cwd: tmp})
	if err != nil {
		t.Fatal(err)
	}
	h := hub.New(&config.Config{PiBin: os.Args[0], AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "sessions"), MaxProcs: 8, IdleTimeout: time.Minute})
	js := New(st, h, max)
	js.BotEnv = func(string) []string { return nil }
	h.Lookup = func(id string) (string, []string, []string, bool) {
		if args, env, ok := js.Extras(id); ok {
			return "", args, env, false
		}
		if bb, err := st.Bot(id); err == nil {
			return bb.Cwd, nil, nil, true
		}
		return "", nil, nil, false
	}
	if prestart != nil {
		prestart(st, b.SessionID)
	}
	ctx, cancel := context.WithCancel(context.Background())
	js.Start(ctx)
	t.Cleanup(func() { cancel(); h.Shutdown(); st.Close() })
	return &env{st: st, h: h, js: js, bot: b.SessionID}
}

func (e *env) wait(t *testing.T, id int64, cond func(store.Job) bool) store.Job {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		j, err := e.st.Job(id)
		if err == nil && cond(j) {
			return j
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %d stuck: %+v", id, j)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func status(s string) func(store.Job) bool { return func(j store.Job) bool { return j.Status == s } }

func TestJobCompletesAndIsDelivered(t *testing.T) {
	e := setup(t, 2, nil)
	j, pos, err := e.js.Create(e.bot, "t", "hello")
	if err != nil || pos != 0 {
		t.Fatalf("create: %v %d", err, pos)
	}
	got := e.wait(t, j.ID, func(j store.Job) bool { return j.Status == "completed" && j.Delivered })
	if !strings.Contains(got.Result, "hello") || got.Tokens != 12 {
		t.Fatalf("result %q tokens %d", got.Result, got.Tokens)
	}
	items, _ := e.st.Items(e.bot, false, 10)
	if len(items) != 1 || items[0].JobID != j.ID || items[0].Kind != "notify" {
		t.Fatalf("inbox %+v", items)
	}
	if _, _, err := e.js.Create("pm-nobody", "t", "x"); err == nil {
		t.Fatal("unknown bot must not get jobs")
	}
}

func TestFailedJob(t *testing.T) {
	e := setup(t, 1, nil)
	j, _, _ := e.js.Create(e.bot, "t", "please FAIL")
	got := e.wait(t, j.ID, status("failed"))
	if got.Error != "fake failure" {
		t.Fatalf("error %q", got.Error)
	}
}

func TestQueueCancelSteer(t *testing.T) {
	e := setup(t, 1, nil)
	a, _, _ := e.js.Create(e.bot, "a", "SLEEP")
	b, posB, _ := e.js.Create(e.bot, "b", "quick")
	if posB != 1 {
		t.Fatalf("b position %d", posB)
	}
	e.wait(t, a.ID, status("running"))
	if j, _ := e.st.Job(b.ID); j.Status != "queued" {
		t.Fatalf("b must wait for the slot, is %s", j.Status)
	}
	if err := e.js.Steer(b.ID, "x"); err == nil {
		t.Fatal("steer of a queued job must fail")
	}
	if _, _, err := e.js.Rerun(a.ID); err == nil {
		t.Fatal("rerun of a running job must fail")
	}
	if err := e.js.Cancel(a.ID); err != nil {
		t.Fatal(err)
	}
	e.wait(t, a.ID, status("cancelled"))
	e.wait(t, b.ID, status("completed"))

	c, _, _ := e.js.Create(e.bot, "c", "SLEEP")
	e.wait(t, c.ID, status("running"))
	time.Sleep(100 * time.Millisecond)
	if err := e.js.Steer(c.ID, "wrap up"); err != nil {
		t.Fatal(err)
	}
	got := e.wait(t, c.ID, status("completed")) // fake pi ends the turn on the steer message
	if !strings.Contains(got.Result, "wrap up") {
		t.Fatalf("steer not delivered: %q", got.Result)
	}
}

func TestInterruptedOnRestartIsNotRerun(t *testing.T) {
	var old int64
	e := setup(t, 2, func(st *store.Store, bot string) {
		j, _ := st.CreateJob(bot, "old", "hello")
		_, _ = st.StartJob(j.ID, SessionID(j.ID)) // left running by a dead Pimu
		old = j.ID
	})
	got := e.wait(t, old, status("interrupted"))
	time.Sleep(200 * time.Millisecond)
	if j, _ := e.st.Job(old); j.Status != "interrupted" || got.Result != "" {
		t.Fatalf("interrupted job ran again: %+v", j)
	}
	n, _, err := e.js.Rerun(old)
	if err != nil || n.ID == old {
		t.Fatalf("rerun: %v id %d", err, n.ID)
	}
	e.wait(t, n.ID, status("completed"))
}

func TestScope(t *testing.T) {
	e := setup(t, 1, nil)
	j, _, _ := e.js.Create(e.bot, "t", "hello")
	sc, ok := e.js.Scope(SessionID(j.ID))
	if !ok || sc.Bot != e.bot || sc.Job != j.ID || sc.Goal != 0 || sc.Session != SessionID(j.ID) {
		t.Fatalf("scope %+v %v", sc, ok)
	}
	if _, ok := e.js.Scope("pm-bot"); ok {
		t.Fatal("bot session is not a job")
	}
	if _, ok := e.js.Scope("pimu-j999"); ok {
		t.Fatal("unknown job")
	}
	e.wait(t, j.ID, status("completed"))
}
