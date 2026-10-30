package store

import (
	"sync"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// fakeClock swaps Clock for the test.
func fakeClock(t *testing.T) *time.Time {
	t.Helper()
	now := time.Now()
	Clock = func() time.Time { return now }
	t.Cleanup(func() { Clock = time.Now })
	return &now
}

func seed(t *testing.T, st *Store) (bot string, goal, job int64) {
	t.Helper()
	b, err := st.CreateBot(Bot{SessionID: "pm-test", Name: "t", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	g, err := st.CreateGoal(Goal{BotID: b.SessionID, Slug: "g", Title: "g", Level: 2, EverySec: 60, DayTokens: 1000, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	j, err := st.CreateJob(b.SessionID, "j", "p")
	if err != nil {
		t.Fatal(err)
	}
	return b.SessionID, g.ID, j.ID
}

func ask(t *testing.T, st *Store, it Item, ref, want string) Item {
	t.Helper()
	out, v, _, err := st.Approve(it, ref)
	if err != nil {
		t.Fatal(err)
	}
	if v != want {
		t.Fatalf("verdict %q, want %q (item %d %s)", v, want, out.ID, out.Status)
	}
	return out
}

func TestApprovalLifecycle(t *testing.T) {
	st := testStore(t)
	fakeClock(t)
	bot, _, job := seed(t, st)
	call := Item{BotID: bot, JobID: job, Tool: "write", ArgsHash: "h1", Title: "w"}

	first, v, isNew, err := st.Approve(call, "s/1")
	if err != nil || v != VerdictPending || !isNew {
		t.Fatalf("first: %v %v %v", v, isNew, err)
	}
	// Asking again while pending neither duplicates nor runs.
	if again, _, isNew, _ := st.Approve(call, "s/2"); again.ID != first.ID || isNew {
		t.Fatal("pending request must be reused, not duplicated")
	}
	ask(t, st, call, "s/2", VerdictPending)

	if ok, _ := st.SetItemStatus(first.ID, "approved", "new", "read"); !ok {
		t.Fatal("approve")
	}
	used := ask(t, st, call, "s/3", VerdictRun)
	if used.ID != first.ID || used.Status != "used" {
		t.Fatalf("claimed row: %+v", used)
	}
	// Single use: the same call again files a fresh request (not blocked forever).
	second := ask(t, st, call, "s/4", VerdictPending)
	if second.ID == first.ID {
		t.Fatal("used approval must not be reused")
	}
	// Bound to args: a different hash does not ride on an approval.
	_, _ = st.SetItemStatus(second.ID, "approved", "new", "read")
	other := call
	other.ArgsHash = "h2"
	ask(t, st, other, "s/5", VerdictPending)
	// ...nor does another job with the same hash.
	j2, _ := st.CreateJob(bot, "j2", "p")
	cross := call
	cross.JobID = j2.ID
	ask(t, st, cross, "s/6", VerdictPending)
	ask(t, st, call, "s/7", VerdictRun)
}

func TestApprovalDeniedAndTTL(t *testing.T) {
	st := testStore(t)
	now := fakeClock(t)
	bot, goal, _ := seed(t, st)
	call := Item{BotID: bot, GoalID: goal, Tool: "bash", ArgsHash: "rm"}

	it := ask(t, st, call, "b/1", VerdictPending)
	_, _ = st.SetItemStatus(it.ID, "denied", "new", "read")
	ask(t, st, call, "b/2", VerdictDenied)
	*now = now.Add(DeniedHold + time.Minute)
	again := ask(t, st, call, "b/3", VerdictPending)
	if again.ID == it.ID {
		t.Fatal("after the hold a new request is filed")
	}

	// Pending too long: expires, and a new request replaces it.
	*now = now.Add(PendingTTL + time.Minute)
	if n, _ := st.ExpireApprovals(); n != 1 {
		t.Fatalf("expired %d", n)
	}
	if got, _ := st.Item(again.ID); got.Status != "expired" {
		t.Fatalf("status %s", got.Status)
	}
	fresh := ask(t, st, call, "b/4", VerdictPending)

	// Approved but unused too long: expires instead of running later.
	_, _ = st.SetItemStatus(fresh.ID, "approved", "new", "read")
	*now = now.Add(ApprovedTTL + time.Minute)
	ask(t, st, call, "b/5", VerdictPending)
	if got, _ := st.Item(fresh.ID); got.Status != "expired" {
		t.Fatalf("stale approval status %s", got.Status)
	}
}

func TestApprovalStatusClaimsOnce(t *testing.T) {
	st := testStore(t)
	fakeClock(t)
	bot, _, job := seed(t, st)
	it := ask(t, st, Item{BotID: bot, JobID: job, Tool: "write", ArgsHash: "h"}, "j/1", VerdictPending)
	if v, _ := st.ApprovalStatus(it.ID, "j/1"); v != VerdictPending {
		t.Fatal(v)
	}
	_, _ = st.SetItemStatus(it.ID, "approved", "new", "read")

	// Two pollers race (retry, duplicate process): exactly one may run.
	var wg sync.WaitGroup
	var mu sync.Mutex
	runs := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if v, err := st.ApprovalStatus(it.ID, "j/1"); err == nil && v == VerdictRun {
				mu.Lock()
				runs++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if runs != 1 {
		t.Fatalf("%d runs, want exactly 1", runs)
	}
	if v, _ := st.ApprovalStatus(it.ID, "j/1"); v != VerdictGone {
		t.Fatalf("after use: %s", v)
	}
}

func TestInterruptExpiresJobApprovals(t *testing.T) {
	st := testStore(t)
	fakeClock(t)
	bot, _, job := seed(t, st)
	if ok, _ := st.StartJob(job, "pimu-j1"); !ok {
		t.Fatal("start")
	}
	it := ask(t, st, Item{BotID: bot, JobID: job, Tool: "write", ArgsHash: "h"}, "j/1", VerdictPending)
	_, _ = st.SetItemStatus(it.ID, "approved", "new", "read")
	if n, _ := st.InterruptJobs(); n != 1 {
		t.Fatalf("interrupted %d", n)
	}
	j, _ := st.Job(job)
	got, _ := st.Item(it.ID)
	if j.Status != "interrupted" || got.Status != "expired" {
		t.Fatalf("job %s approval %s", j.Status, got.Status)
	}
}

func TestApproveValidates(t *testing.T) {
	st := testStore(t)
	bot, goal, job := seed(t, st)
	for _, it := range []Item{{BotID: bot, ArgsHash: "h"}, {BotID: bot, GoalID: goal, JobID: job, ArgsHash: "h"}, {BotID: bot, GoalID: goal}} {
		if _, _, _, err := st.Approve(it, "x"); err == nil {
			t.Fatalf("accepted %+v", it)
		}
	}
}
