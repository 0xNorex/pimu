package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirsStayInsideRoots(t *testing.T) {
	r := newRig(t)
	root := t.TempDir()
	outside := t.TempDir()
	for _, d := range []string{"a/b", "c", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.Symlink(outside, filepath.Join(root, "escape"))
	r.s.cfg.Token = strings.Repeat("t", 32)
	r.s.cfg.Workdirs = []string{root}
	h := r.s.Handler(os.DirFS(t.TempDir()))
	call := func(method, path, body string) (int, map[string]any) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+strings.Repeat("t", 32))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	q := func(p string) string { return "/api/dirs?path=" + url.QueryEscape(p) }

	code, out := call("GET", q(root), "")
	if code != 200 || out["parent"] != nil {
		t.Fatalf("root: %d %v", code, out)
	}
	// escape is a symlink out of the root: still listed by name, but not enterable.
	if got := out["dirs"].([]any); len(got) != 3 || got[0] != "a" || got[1] != "c" || got[2] != "escape" {
		t.Fatalf("dirs: %v", got)
	}
	if code, out = call("GET", q(filepath.Join(root, "a")), ""); code != 200 || out["parent"] != root {
		t.Fatalf("sub: %d %v", code, out)
	}
	for _, bad := range []string{filepath.Join(root, "escape"), filepath.Join(root, "a", "..", ".."), outside, "/"} {
		if code, _ := call("GET", q(bad), ""); code != 400 {
			t.Errorf("%s: %d, want 400", bad, code)
		}
	}
	if code, out = call("POST", "/api/dirs", `{"path":"`+root+`","name":"new"}`); code != 200 || out["path"] != filepath.Join(root, "new") {
		t.Fatalf("mkdir: %d %v", code, out)
	}
	for _, name := range []string{"", "..", "x/y", ".git"} {
		if code, _ := call("POST", "/api/dirs", `{"path":"`+root+`","name":"`+name+`"}`); code != 400 {
			t.Errorf("mkdir %q: %d, want 400", name, code)
		}
	}
	if code, _ := call("POST", "/api/dirs", `{"path":"`+outside+`","name":"x"}`); code != 400 {
		t.Errorf("mkdir outside: %d", code)
	}
	// Empty cwd means the first root, not the process cwd.
	if d, ok := r.s.cfg.AllowedDir(""); !ok || d != root {
		t.Errorf("AllowedDir(\"\") = %q %v", d, ok)
	}
}
