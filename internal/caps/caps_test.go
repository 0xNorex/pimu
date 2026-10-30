package caps

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIssueCheckRevoke(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run")
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "leftover"), []byte("x"), 0o600)
	r, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "leftover")); !os.IsNotExist(err) {
		t.Fatal("New must wipe leftovers")
	}
	sc := Scope{Session: "pimu-j7", Bot: "pm-a", Job: 7}
	kv, err := r.Issue(sc)
	if err != nil {
		t.Fatal(err)
	}
	path, ok := strings.CutPrefix(kv, "PIMU_CAP_FILE=")
	if !ok || !strings.HasPrefix(path, dir+"/") {
		t.Fatalf("env %q", kv)
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("cap file mode: %v %v", fi, err)
	}
	b, _ := os.ReadFile(path)
	tok := string(b)
	if len(tok) != 64 || strings.Contains(kv, tok) {
		t.Fatalf("token must be 64 hex and not in env")
	}
	if got, ok := r.Check(tok); !ok || got != sc {
		t.Fatalf("check: %v %v", got, ok)
	}
	for _, bad := range []string{"", tok[:63], tok + "0", strings.ToUpper(tok)} {
		if _, ok := r.Check(bad); ok && bad != tok {
			t.Fatalf("accepted %q", bad)
		}
	}
	// Re-issue (respawn) replaces the old token.
	kv2, _ := r.Issue(sc)
	b2, _ := os.ReadFile(strings.TrimPrefix(kv2, "PIMU_CAP_FILE="))
	if _, ok := r.Check(tok); ok {
		t.Fatal("old token must die on re-issue")
	}
	if _, ok := r.Check(string(b2)); !ok {
		t.Fatal("new token must work")
	}
	r.Revoke("pimu-j7")
	if _, ok := r.Check(string(b2)); ok {
		t.Fatal("revoked token must fail")
	}
}
