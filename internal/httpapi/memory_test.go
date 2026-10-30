package httpapi

import (
	"os"
	"path/filepath"
	"testing"
)

// The web UI sends mtime back as a JS number; it must survive float64.
func TestMtimeFitsJSNumber(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	mt, err := mtimeOf(p)
	if err != nil || mt <= 0 || int64(float64(mt)) != mt {
		t.Fatalf("mtime %d does not round-trip through float64", mt)
	}
}
