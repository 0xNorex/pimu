// Package lock implements the per-session lock file shared with the
// pimu-guard pi extension (see docs/DESIGN.md §3.3A).
package lock

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

var ErrBusy = errors.New("session is locked by another process")

type Info struct {
	PID   int    `json:"pid"`
	Owner string `json:"owner"` // "pimu" | "pi-cli"
	Host  string `json:"host"`
	At    string `json:"at"`
}

func Path(agentDir, id string) string {
	return filepath.Join(agentDir, "locks", id+".lock")
}

// Acquire creates the lock file for id owned by this process.
func Acquire(agentDir, id string) error {
	p := Path(agentDir, id)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return fmt.Errorf("lock dir: %w", err)
	}
	host, _ := os.Hostname()
	data, _ := json.Marshal(Info{PID: os.Getpid(), Owner: "pimu", Host: host, At: time.Now().UTC().Format(time.RFC3339)})
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, werr := f.Write(data)
			cerr := f.Close()
			return errors.Join(werr, cerr)
		}
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("create lock: %w", err)
		}
		if _, live := Peek(agentDir, id); live {
			return ErrBusy
		}
		_ = os.Remove(p) // stale, retry once
	}
	return ErrBusy
}

// Release removes the lock if this process owns it.
func Release(agentDir, id string) {
	if info, live := Peek(agentDir, id); live && info.PID == os.Getpid() && info.Owner == "pimu" {
		_ = os.Remove(Path(agentDir, id))
	}
}

// Peek returns the current holder and whether that lock is still live.
func Peek(agentDir, id string) (Info, bool) {
	var info Info
	b, err := os.ReadFile(Path(agentDir, id))
	if err != nil {
		return info, false
	}
	if json.Unmarshal(b, &info) != nil || info.PID <= 0 {
		return info, false
	}
	host, _ := os.Hostname()
	if info.Host != "" && info.Host != host {
		at, err := time.Parse(time.RFC3339, info.At)
		return info, err == nil && time.Since(at) < 24*time.Hour
	}
	err = syscall.Kill(info.PID, 0)
	return info, err == nil || errors.Is(err, syscall.EPERM)
}
