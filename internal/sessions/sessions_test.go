package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindSeesChangesAndRemoval(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "--tmp--")
	os.MkdirAll(sub, 0o755)
	p := filepath.Join(sub, "a.jsonl")
	head := `{"type":"session","id":"s1","cwd":"/tmp"}` + "\n"
	os.WriteFile(p, []byte(head), 0o644)
	x := NewIndex(dir)
	if _, ok := x.Find("s1"); !ok {
		t.Fatal("not found")
	}
	os.WriteFile(p, []byte(head+`{"type":"session_info","name":"renamed"}`+"\n"), 0o644)
	if s, _ := x.Find("s1"); s.Name != "renamed" {
		t.Fatalf("stale: %+v", s)
	}
	os.Remove(p)
	if _, ok := x.Find("s1"); ok {
		t.Fatal("removed file still found")
	}
}

func TestMessagesPlaceCompactionAndMerge(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	lines := `{"type":"session","id":"s1","cwd":"/tmp"}
{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"one"}}
{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":"two"}}
{"type":"message","id":"c","parentId":"b","message":{"role":"user","content":"three"}}
{"type":"compaction","id":"k","parentId":"c","summary":"S","firstKeptEntryId":"c","tokensBefore":9,"timestamp":"2026-01-01T00:00:00Z"}
{"type":"message","id":"d","parentId":"k","message":{"role":"assistant","content":"four"}}
`
	os.WriteFile(p, []byte(lines), 0o644)
	m, err := Messages(p)
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, x := range m {
		roles = append(roles, Role(x))
	}
	if got := strings.Join(roles, ","); got != "user,assistant,compactionSummary,user,assistant" {
		t.Fatalf("file order: %s", got)
	}
	// live context: summary + kept + new; merged = full history
	live := []json.RawMessage{m[2], m[3], m[4]}
	if got := len(MergeCompacted(live, m)); got != 5 {
		t.Fatalf("merged %d, want 5", got)
	}
	if got := len(MergeCompacted(m[:2], m)); got != 2 {
		t.Fatalf("uncompacted live must pass through, got %d", got)
	}
}
