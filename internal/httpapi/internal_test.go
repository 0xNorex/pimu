package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/0xNorex/pimu/internal/caps"
	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/goals"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/jobs"
	"github.com/0xNorex/pimu/internal/notify"
	"github.com/0xNorex/pimu/internal/store"
)

type rig struct {
	s    *Server
	st   *store.Store
	reg  *caps.Registry
	bot  string
	goal int64
	job  int64
	tok  map[string]string // name -> capability token
}

func newRig(t *testing.T) *rig {
	t.Helper()
	tmp := t.TempDir()
	st, err := store.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	b, _ := st.CreateBot(store.Bot{SessionID: "pm-a", Name: "a", Cwd: tmp})
	_, _ = st.CreateBot(store.Bot{SessionID: "pm-other", Name: "o", Cwd: tmp})
	g, _ := st.CreateGoal(store.Goal{BotID: b.SessionID, Slug: "g", Title: "g", Level: 2, EverySec: 60, DayTokens: 1000, Enabled: true})
	j, _ := st.CreateJob(b.SessionID, "j", "p")
	_, _ = st.StartJob(j.ID, jobs.SessionID(j.ID))
	cfg := &config.Config{AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "s"), MaxProcs: 1}
	h := hub.New(cfg)
	gs := goals.New(st, h, nil, notify.Telegram{}, tmp, "", "127.0.0.1:1")
	js := jobs.New(st, h, 0) // Max 0: nothing actually runs
	reg, _ := caps.New(filepath.Join(tmp, "run"))
	s := New(cfg, h, st, nil, gs, js, "test", "test")
	s.Caps = reg
	r := &rig{s: s, st: st, reg: reg, bot: b.SessionID, goal: g.ID, job: j.ID, tok: map[string]string{}}
	for name, sc := range map[string]caps.Scope{
		"main":  {Session: "pm-a", Bot: "pm-a"},
		"beat":  {Session: "pimu-g1-b1", Bot: "pm-a", Goal: g.ID},
		"job":   {Session: jobs.SessionID(j.ID), Bot: "pm-a", Job: j.ID},
		"other": {Session: "pm-other", Bot: "pm-other"},
	} {
		kv, err := reg.Issue(sc)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(strings.TrimPrefix(kv, "PIMU_CAP_FILE="))
		r.tok[name] = string(b)
	}
	return r
}

func (r *rig) do(t *testing.T, method, path, tok, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("X-Pimu-Cap", tok)
	}
	w := httptest.NewRecorder()
	r.s.Handler(os.DirFS(t.TempDir())).ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestInternalAuth(t *testing.T) {
	r := newRig(t)
	for _, tok := range []string{"", "nope", strings.Repeat("0", 64)} {
		if code, _ := r.do(t, "POST", "/api/internal/approvals", tok, `{"tool":"bash","args":{}}`); code != 403 {
			t.Fatalf("token %q: %d", tok, code)
		}
	}
	// The server's own login token style header is not accepted either.
	req := httptest.NewRequest("POST", "/api/internal/jobs", strings.NewReader(`{"prompt":"x"}`))
	req.Header.Set("Authorization", "Bearer "+r.tok["main"])
	w := httptest.NewRecorder()
	r.s.Handler(os.DirFS(t.TempDir())).ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("bearer: %d", w.Code)
	}
}

func TestDelegateScope(t *testing.T) {
	r := newRig(t)
	for _, who := range []string{"beat", "job"} {
		if code, _ := r.do(t, "POST", "/api/internal/jobs", r.tok[who], `{"title":"t","prompt":"p"}`); code != 403 {
			t.Fatalf("%s may not delegate: %d", who, code)
		}
	}
	// The body cannot pick another bot: the job belongs to the token's bot.
	code, out := r.do(t, "POST", "/api/internal/jobs", r.tok["other"], `{"bot":"pm-a","title":"t","prompt":"p"}`)
	if code != 200 {
		t.Fatalf("delegate: %d %v", code, out)
	}
	j, _ := r.st.Job(int64(out["id"].(float64)))
	if j.BotID != "pm-other" {
		t.Fatalf("job went to %s", j.BotID)
	}
}

func TestApprovalFlowOverHTTP(t *testing.T) {
	r := newRig(t)
	if code, _ := r.do(t, "POST", "/api/internal/approvals", r.tok["main"], `{"tool":"bash","args":{"command":"x"}}`); code != 403 {
		t.Fatalf("main session files no approvals: %d", code)
	}
	req := `{"tool":"write","args":{"path":"/etc/x","content":"Bearer abcdefgh123"},"reason":"/etc/x","toolCallId":"c1"}`
	code, out := r.do(t, "POST", "/api/internal/approvals", r.tok["job"], req)
	if code != 200 || out["verdict"] != "pending" {
		t.Fatalf("first: %d %v", code, out)
	}
	id := int64(out["id"].(float64))
	it, _ := r.st.Item(id)
	if it.JobID != r.job || it.BotID != r.bot || strings.Contains(it.Body, "abcdefgh123") {
		t.Fatalf("item %+v", it)
	}
	if j, _ := r.st.Job(r.job); j.Status != "waiting_approval" {
		t.Fatalf("job %s", j.Status)
	}
	// Same args in another key order: same request (hash is canonical, server-side).
	_, out = r.do(t, "POST", "/api/internal/approvals", r.tok["job"], `{"tool":"write","args":{"content":"Bearer abcdefgh123","path":"/etc/x"},"toolCallId":"c2"}`)
	if int64(out["id"].(float64)) != id {
		t.Fatal("key order changed the hash")
	}
	// The heartbeat cannot see or claim the job's approval.
	if code, _ := r.do(t, "POST", "/api/internal/approvals/"+strconv.FormatInt(id, 10)+"/status", r.tok["beat"], `{}`); code != 404 {
		t.Fatalf("cross-scope status: %d", code)
	}
	// The user approves.
	_, _ = r.st.SetItemStatus(id, "approved", "new", "read")
	_, out = r.do(t, "POST", "/api/internal/approvals/"+strconv.FormatInt(id, 10)+"/status", r.tok["job"], `{"toolCallId":"c2"}`)
	if out["verdict"] != "run" {
		t.Fatalf("status after approve: %v", out)
	}
	_, out = r.do(t, "POST", "/api/internal/approvals/"+strconv.FormatInt(id, 10)+"/status", r.tok["job"], `{"toolCallId":"c2"}`)
	if out["verdict"] != "gone" {
		t.Fatalf("second claim must fail: %v", out)
	}
	// Identical call later: a fresh request, not a silent rerun and not a permanent block.
	_, out = r.do(t, "POST", "/api/internal/approvals", r.tok["job"], req)
	if out["verdict"] != "pending" || int64(out["id"].(float64)) == id {
		t.Fatalf("repeat: %v", out)
	}
	if used, _ := r.st.Item(id); used.Status != "used" {
		t.Fatalf("used row %s", used.Status)
	}
}

func TestArgsHash(t *testing.T) {
	sc := caps.Scope{Bot: "pm-a", Job: 1}
	var a, b map[string]any
	_ = json.Unmarshal([]byte(`{"x":1,"y":{"b":2,"a":[1,"s"]}}`), &a)
	_ = json.Unmarshal([]byte(`{"y":{"a":[1,"s"],"b":2},"x":1}`), &b)
	if ArgsHash(sc, "t", a) != ArgsHash(sc, "t", b) {
		t.Fatal("canonical args must hash the same")
	}
	for _, other := range []string{ArgsHash(sc, "u", a), ArgsHash(caps.Scope{Bot: "pm-a", Job: 2}, "t", a), ArgsHash(caps.Scope{Bot: "pm-b", Job: 1}, "t", a), ArgsHash(caps.Scope{Bot: "pm-a", Goal: 1}, "t", a)} {
		if other == ArgsHash(sc, "t", a) {
			t.Fatal("tool / job / bot / goal must change the hash")
		}
	}

}
