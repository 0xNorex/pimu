package lock

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestAcquireBusyRelease(t *testing.T) {
	dir := t.TempDir()
	if err := Acquire(dir, "pm-a"); err != nil {
		t.Fatal(err)
	}
	if err := Acquire(dir, "pm-a"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second acquire: %v", err)
	}
	if err := Acquire(dir, "pm-b"); err != nil {
		t.Fatalf("other session: %v", err)
	}
	info, live := Peek(dir, "pm-a")
	if !live || info.PID != os.Getpid() || info.Owner != "pimu" {
		t.Fatalf("peek %+v %v", info, live)
	}
	if fi, _ := os.Stat(Path(dir, "pm-a")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	Release(dir, "pm-a")
	if _, live := Peek(dir, "pm-a"); live {
		t.Fatal("released")
	}
	if err := Acquire(dir, "pm-a"); err != nil {
		t.Fatal(err)
	}
}

func TestStaleLockIsTaken(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Skip("no true binary")
	}
	host, _ := os.Hostname()
	b, _ := json.Marshal(Info{PID: cmd.Process.Pid, Owner: "pi-cli", Host: host})
	_ = os.MkdirAll(filepath.Join(dir, "locks"), 0o700)
	_ = os.WriteFile(Path(dir, "pm-a"), b, 0o600)
	if err := Acquire(dir, "pm-a"); err != nil {
		t.Fatalf("stale lock: %v", err)
	}
}

func TestReleaseKeepsForeignLock(t *testing.T) {
	dir := t.TempDir()
	host, _ := os.Hostname()
	b, _ := json.Marshal(Info{PID: os.Getppid(), Owner: "pi-cli", Host: host}) // live, not us
	_ = os.MkdirAll(filepath.Join(dir, "locks"), 0o700)
	_ = os.WriteFile(Path(dir, "pm-a"), b, 0o600)
	if err := Acquire(dir, "pm-a"); !errors.Is(err, ErrBusy) {
		t.Fatalf("live foreign lock: %v", err)
	}
	Release(dir, "pm-a")
	if _, err := os.Stat(Path(dir, "pm-a")); err != nil {
		t.Fatal("Release must not remove another process's lock")
	}
}
