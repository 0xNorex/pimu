package sessions

import (
	"os"
	"path/filepath"
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
