// Package caps issues the per-process capability pimu-agent.ts uses to call
// /api/internal/*. Nothing secret goes into a pi process's environment (its
// tools' child processes inherit it, and /proc/<pid>/environ is readable):
// env only names a 0600 file that the extension reads and deletes at load.
// The token is scoped to one session's own bot, goal or job, so even a token
// the model managed to recover grants nothing the session cannot already do.
package caps

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
)

// Scope is what a token may act on. Bot is always set; Goal or Job is set for
// heartbeats / goal subtasks / background jobs; neither for a bot's main session.
type Scope struct {
	Session string
	Bot     string
	Goal    int64
	Job     int64
}

type Registry struct {
	dir   string
	mu    sync.Mutex
	byTok map[string]Scope
	bySes map[string]string
}

// New uses dir for the hand-over files; leftovers from a previous run are removed.
func New(dir string) (*Registry, error) {
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Registry{dir: dir, byTok: map[string]Scope{}, bySes: map[string]string{}}, nil
}

// Issue replaces the session's token with a fresh one and returns the env
// entry (PIMU_CAP_FILE=<path>) for the pi process about to start.
func (r *Registry) Issue(s Scope) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(b)
	n := make([]byte, 8)
	_, _ = rand.Read(n)
	p := filepath.Join(r.dir, hex.EncodeToString(n))
	if err := os.WriteFile(p, []byte(tok), 0o600); err != nil {
		return "", err
	}
	r.mu.Lock()
	if old, ok := r.bySes[s.Session]; ok {
		delete(r.byTok, old)
	}
	r.byTok[tok], r.bySes[s.Session] = s, tok
	r.mu.Unlock()
	return "PIMU_CAP_FILE=" + p, nil
}

// Revoke drops the session's token (its pi process is gone).
func (r *Registry) Revoke(session string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if tok, ok := r.bySes[session]; ok {
		delete(r.byTok, tok)
		delete(r.bySes, session)
	}
}

// Check returns the scope of a presented token.
func (r *Registry) Check(tok string) (Scope, bool) {
	if len(tok) != 64 {
		return Scope{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for t, s := range r.byTok { // constant-time compare; the map is tiny
		if subtle.ConstantTimeCompare([]byte(t), []byte(tok)) == 1 {
			return s, true
		}
	}
	return Scope{}, false
}
