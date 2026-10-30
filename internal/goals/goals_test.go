package goals

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/notify"
	"github.com/0xNorex/pimu/internal/store"
)

func TestParseActions(t *testing.T) {
	cases := []struct {
		text string
		want []string // Do of each action; nil = error
	}{
		{"```pimu\n{\"do\":\"noop\"}\n```", []string{"noop"}},
		{"thinking...\n```pimu\n[{\"do\":\"notify\",\"title\":\"a\"},{\"do\":\"state\",\"md\":\"x\"}]\n```", []string{"notify", "state"}},
		{"```pimu\n{\"do\":\"notify\"}\n```\nlater:\n```pimu\n{\"do\":\"ask\",\"question\":\"q\"}\n```", []string{"ask"}}, // last block wins
		{"no block here", nil},
		{"```pimu\nnot json\n```", nil},
		{"```json\n{\"do\":\"noop\"}\n```", nil},
	}
	for _, c := range cases {
		got, err := parseActions(c.text)
		if c.want == nil {
			if err == nil {
				t.Errorf("%q: want error, got %+v", c.text, got)
			}
			continue
		}
		var dos []string
		for _, a := range got {
			dos = append(dos, a.Do)
		}
		if err != nil || strings.Join(dos, ",") != strings.Join(c.want, ",") {
			t.Errorf("%q: got %v %v", c.text, dos, err)
		}
	}
}

func TestInHours(t *testing.T) {
	at := func(h int) time.Time { return time.Date(2026, 1, 1, h, 30, 0, 0, time.Local) }
	for _, c := range []struct {
		spec string
		h    int
		want bool
	}{{"", 3, true}, {"8-23", 3, false}, {"8-23", 8, true}, {"8-23", 23, false}, {"22-6", 23, true}, {"22-6", 5, true}, {"22-6", 12, false}, {"junk", 3, true}} {
		if got := inHours(c.spec, at(c.h)); got != c.want {
			t.Errorf("inHours(%q, %d) = %v", c.spec, c.h, got)
		}
	}
}

type fixture struct {
	st  *store.Store
	gs  *Service
	g   store.Goal
	now *time.Time
}

func setup(t *testing.T) *fixture {
	t.Helper()
	tmp := t.TempDir()
	st, err := store.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	b, _ := st.CreateBot(store.Bot{SessionID: "pm-b", Name: "b", Cwd: tmp})
	g, err := st.CreateGoal(store.Goal{BotID: b.SessionID, Slug: "g", Title: "g", Level: 1, EverySec: 600, DayTokens: 1000, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	h := hub.New(&config.Config{AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "s"), MaxProcs: 1})
	gs := New(st, h, nil, notify.Telegram{}, tmp, "", "127.0.0.1:1")
	now := time.Now()
	gs.Now = func() time.Time { return now }
	if err := gs.WriteGoalMD(g, "watch the thing"); err != nil {
		t.Fatal(err)
	}
	return &fixture{st: st, gs: gs, g: g, now: &now}
}

func (f *fixture) goal(t *testing.T) store.Goal {
	g, err := f.st.Goal(f.g.ID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestPrecheckOrder(t *testing.T) {
	f := setup(t)
	if r := f.gs.Precheck(f.goal(t), false); r != "" {
		t.Fatalf("fresh goal should run: %s", r)
	}
	// next_at in the future: not due unless forced or an event is pending.
	_ = f.st.SetNextAt(f.g.ID, f.now.Add(time.Hour))
	if r := f.gs.Precheck(f.goal(t), false); r != "未到时间" {
		t.Fatalf("got %q", r)
	}
	if r := f.gs.Precheck(f.goal(t), true); r != "" {
		t.Fatalf("force: %q", r)
	}
	if _, err := f.gs.Event(f.g.ID, "hook", "k1", "{}"); err != nil {
		t.Fatal(err)
	}
	if r := f.gs.Precheck(f.goal(t), false); r != "" {
		t.Fatalf("pending event should wake: %q", r)
	}
	// Day budget is checked before the schedule and even when forced.
	b, _ := f.st.StartBeat(f.g.ID)
	_ = f.st.FinishBeat(b, "ok", 1000, "noop", "")
	if r := f.gs.Precheck(f.goal(t), true); !strings.Contains(r, "token 已用完") {
		t.Fatalf("budget: %q", r)
	}
	// Outside active hours wins over the budget.
	g := f.goal(t)
	g.ActiveHours = "8-9"
	*f.now = time.Date(f.now.Year(), f.now.Month(), f.now.Day(), 3, 0, 0, 0, time.Local)
	if r := f.gs.Precheck(g, true); !strings.Contains(r, "不在活跃时段") {
		t.Fatalf("hours: %q", r)
	}
	g.Enabled = false
	if r := f.gs.Precheck(g, true); r != "目标已停用" {
		t.Fatalf("disabled: %q", r)
	}
}

func TestPrecheckRateAndBusy(t *testing.T) {
	f := setup(t)
	running, _ := f.st.StartBeat(f.g.ID)
	if r := f.gs.Precheck(f.goal(t), true); r != "上一次心跳还在跑" {
		t.Fatalf("busy: %q", r)
	}
	_ = f.st.FinishBeat(running, "ok", 1, "noop", "")
	for i := 1; i < maxPerHour; i++ {
		b, _ := f.st.StartBeat(f.g.ID)
		_ = f.st.FinishBeat(b, "ok", 1, "noop", "")
	}
	if r := f.gs.Precheck(f.goal(t), true); !strings.Contains(r, "每小时最多") {
		t.Fatalf("rate: %q", r)
	}
	*f.now = f.now.Add(61 * time.Minute) // the hour window moves on
	if r := f.gs.Precheck(f.goal(t), true); r != "" {
		t.Fatalf("after an hour: %q", r)
	}
}

func TestAutoDisableAfterFailures(t *testing.T) {
	f := setup(t)
	for i := 0; i < maxFails; i++ {
		if !f.goal(t).Enabled {
			t.Fatalf("disabled too early after %d", i)
		}
		b, _ := f.st.StartBeat(f.g.ID)
		f.gs.finish(f.goal(t), b, map[bool]string{true: "budget", false: "error"}[i%2 == 0], 5, "", "boom", nil)
	}
	if f.goal(t).Enabled {
		t.Fatal("goal should be disabled after consecutive failures")
	}
	items, _ := f.st.Items("pm-b", false, 10)
	if len(items) != 1 || !strings.Contains(items[0].Title, "已自动停用") {
		t.Fatalf("inbox %+v", items)
	}
	// next_at moves by the interval on the fake clock
	if g := f.goal(t); g.NextAt == nil || *g.NextAt != f.now.Add(600*time.Second).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Fatalf("next_at %v", g.NextAt)
	}
}

func TestOneSuccessResetsFailures(t *testing.T) {
	f := setup(t)
	for _, st := range []string{"error", "error", "ok", "error", "error"} {
		b, _ := f.st.StartBeat(f.g.ID)
		f.gs.finish(f.goal(t), b, st, 1, "", "", nil)
	}
	if !f.goal(t).Enabled {
		t.Fatal("non-consecutive failures must not disable")
	}
}

func TestApplyDedupAndState(t *testing.T) {
	f := setup(t)
	bot, _ := f.st.Bot("pm-b")
	text := "```pimu\n[{\"do\":\"notify\",\"key\":\"k\",\"title\":\"hi\"},{\"do\":\"ask\",\"question\":\"ok?\"},{\"do\":\"state\",\"md\":\"" + strings.Repeat("s", stateMax+10) + "\"},{\"do\":\"bogus\"}]\n```"
	if got := f.gs.apply(f.goal(t), bot, 1, text); got != "notify,ask,state" {
		t.Fatalf("outcome %q", got)
	}
	f.gs.apply(f.goal(t), bot, 2, text) // same keys: no duplicate inbox rows
	if items, _ := f.st.Items("pm-b", false, 10); len(items) != 2 {
		t.Fatalf("%d items", len(items))
	}
	if s := f.gs.ReadStateMD(f.goal(t)); len(s) != stateMax {
		t.Fatalf("state %d bytes", len(s))
	}
	if got := f.gs.apply(f.goal(t), bot, 3, "no block"); got != "noop(parse)" {
		t.Fatalf("unreadable: %q", got)
	}
}

func TestScopeAndExtrasCarryNoToken(t *testing.T) {
	f := setup(t)
	sid := fmt.Sprintf("pimu-g%d-b3", f.g.ID)
	sc, ok := f.gs.Scope(sid)
	if !ok || sc.Bot != "pm-b" || sc.Goal != f.g.ID || sc.Job != 0 {
		t.Fatalf("beat scope %+v %v", sc, ok)
	}
	if sc, ok := f.gs.Scope("pm-b"); !ok || sc.Goal != 0 || sc.Bot != "pm-b" {
		t.Fatalf("bot scope %+v", sc)
	}
	if _, ok := f.gs.Scope("pm-unknown"); ok {
		t.Fatal("unknown session has no scope")
	}
	for _, id := range []string{sid, "pm-b"} {
		_, env := f.gs.Extras(id)
		for _, kv := range env {
			if strings.Contains(kv, "TOKEN") {
				t.Fatalf("%s env carries a token: %s", id, kv)
			}
		}
	}
}

func TestPromptCarriesClockGoalAndState(t *testing.T) {
	f := setup(t)
	*f.now = time.Date(2026, 1, 2, 3, 4, 0, 0, time.UTC)
	bot, _ := f.st.Bot("pm-b")
	f.gs.apply(f.goal(t), bot, 1, "```pimu\n[{\"do\":\"state\",\"md\":\"round: 7\"}]\n```")
	p := f.gs.prompt(f.goal(t), 8, nil)
	for _, want := range []string{"2026-01-02 03:04", "watch the thing", "round: 7", "心跳 #8"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
}

func TestGuardedBotGetsModeEnv(t *testing.T) {
	f := setup(t)
	has := func() bool {
		_, env := f.gs.Extras("pm-b")
		return strings.Contains(strings.Join(env, " "), "PIMU_MODE=guarded")
	}
	if has() {
		t.Fatal("trusted bot must run native")
	}
	b, _ := f.st.Bot("pm-b")
	b.Mode = store.ModeGuarded
	_, _ = f.st.UpdateBot(b)
	if !has() {
		t.Fatal("guarded bot lacks PIMU_MODE")
	}
}
