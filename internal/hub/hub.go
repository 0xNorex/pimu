// Package hub owns the running pi processes: at most one per session,
// bounded by MaxProcs, reaped when idle, guarded by the session lock.
package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/lock"
	"github.com/0xNorex/pimu/internal/pirpc"
	"github.com/0xNorex/pimu/internal/sessions"
)

var (
	ErrNotFound = errors.New("session not found")
	ErrTooMany  = errors.New("too many running pi processes")
	ErrLocked   = errors.New("session is in use by another pi process")
	ErrTimeout  = errors.New("pi did not respond in time")
)

const cmdTimeout = 30 * time.Second

type Run struct {
	ID   string
	Cwd  string
	proc *pirpc.Proc

	mu         sync.Mutex
	streaming  bool
	lastActive time.Time
	timeouts   int
}

func (r *Run) Streaming() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.streaming
}

func (r *Run) touch() {
	r.mu.Lock()
	r.lastActive = time.Now()
	r.mu.Unlock()
}

type Hub struct {
	cfg *config.Config
	Idx *sessions.Index

	mu      sync.Mutex
	runs    map[string]*Run
	streams map[string]*Stream
	known   map[string]string // id -> cwd, sessions created here that may have no file yet

	// Lookup supplies per-session extras: the cwd of a session that has no file
	// yet (a new bot; ok reports whether cwd is known), extra pi args (a bot's
	// persona) and extra env (PIMU_* for bots, heartbeats, goal tasks). Optional.
	Lookup func(id string) (cwd string, args, env []string, ok bool)
	// SpawnEnv adds env for one pi process about to start (its capability
	// file, see internal/caps). Optional.
	SpawnEnv func(id string) []string

	// Global carries cross-session events (proc_state with id, run_update) for /api/events.
	Global *Stream

	modelsMu sync.Mutex
	models   json.RawMessage
	modelsAt time.Time
}

func New(cfg *config.Config) *Hub {
	return &Hub{cfg: cfg, Idx: sessions.NewIndex(cfg.SessionDir, filepath.Join(cfg.DataDir, "bots", "*", "session", "*.jsonl")), runs: map[string]*Run{}, streams: map[string]*Stream{}, known: map[string]string{}, Global: newStream()}
}

// Stream returns the event stream for id, creating it if needed.
func (h *Hub) Stream(id string) *Stream {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.streams[id]
	if !ok {
		s = newStream()
		h.streams[id] = s
	}
	return s
}

func (h *Hub) Running(id string) *Run {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.runs[id]
}

// Known lists sessions started here that do not have a file yet.
func (h *Hub) Known() map[string]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[string]string, len(h.known))
	for k, v := range h.known {
		out[k] = v
	}
	return out
}

// Status is idle | running | streaming | external.
func (h *Hub) Status(id string) string {
	if r := h.Running(id); r != nil {
		if r.Streaming() {
			return "streaming"
		}
		return "running"
	}
	if info, live := lock.Peek(h.cfg.AgentDir, id); live && !(info.Owner == "pimu" && info.PID == os.Getpid()) {
		return "external"
	}
	return "idle"
}

func NewID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "pm-" + hex.EncodeToString(b)
}

// Create starts a new pi session in cwd and returns its id.
func (h *Hub) Create(ctx context.Context, cwd string) (*Run, error) {
	return h.CreateWithID(ctx, NewID(), cwd)
}

// CreateWithID starts a brand-new session with a caller-chosen id (task runs).
func (h *Hub) CreateWithID(ctx context.Context, id, cwd string) (*Run, error) {
	h.mu.Lock()
	h.known[id] = cwd
	h.mu.Unlock()
	r, err := h.start(ctx, id, cwd, []string{"--session-id", id})
	if err != nil {
		h.mu.Lock()
		delete(h.known, id)
		h.mu.Unlock()
	}
	return r, err
}

// Ensure returns the running process for id, starting it if needed.
func (h *Hub) Ensure(ctx context.Context, id string) (*Run, error) {
	if r := h.Running(id); r != nil {
		return r, nil
	}
	if info, ok := h.Idx.Find(id); ok {
		return h.start(ctx, id, info.Cwd, []string{"--session", info.Path})
	}
	h.mu.Lock()
	cwd, ok := h.known[id]
	h.mu.Unlock()
	if !ok && h.Lookup != nil {
		cwd, _, _, ok = h.Lookup(id)
	}
	if ok {
		return h.start(ctx, id, cwd, []string{"--session-id", id})
	}
	return nil, ErrNotFound
}

func (h *Hub) start(ctx context.Context, id, cwd string, sessArgs []string) (*Run, error) {
	h.mu.Lock()
	if r := h.runs[id]; r != nil {
		h.mu.Unlock()
		return r, nil
	}
	if len(h.runs) >= h.cfg.MaxProcs {
		h.mu.Unlock()
		return nil, ErrTooMany
	}
	if err := lock.Acquire(h.cfg.AgentDir, id); err != nil {
		h.mu.Unlock()
		if errors.Is(err, lock.ErrBusy) {
			return nil, ErrLocked
		}
		return nil, err
	}
	stream := h.streams[id]
	if stream == nil {
		stream = newStream()
		h.streams[id] = stream
	}
	r := &Run{ID: id, Cwd: cwd, lastActive: time.Now()}
	args := append([]string{"--mode", "rpc"}, sessArgs...)
	args = append(args, h.cfg.PiArgs...)
	env := append(ChildEnv(os.Environ()), "PIMU_LOCK_OWNER="+id)
	if h.Lookup != nil {
		_, extra, extraEnv, _ := h.Lookup(id)
		args = append(args, extra...)
		env = append(env, extraEnv...)
	}
	if h.SpawnEnv != nil {
		env = append(env, h.SpawnEnv(id)...)
	}
	proc, err := pirpc.Start(h.cfg.PiBin, args, cwd, env, func(line []byte) { h.onEvent(r, stream, line) })
	if err != nil {
		lock.Release(h.cfg.AgentDir, id)
		h.mu.Unlock()
		return nil, err
	}
	r.proc = proc
	h.runs[id] = r
	h.mu.Unlock()

	slog.Info("pi started", "session", id, "pid", proc.Pid())
	pimuEvent(stream, map[string]any{"type": "lock", "holder": "pimu"})
	pimuEvent(stream, map[string]any{"type": "proc_state", "state": "starting"})
	go h.watch(r, stream)

	// get_state doubles as the readiness check.
	_, err = h.Call(ctx, r, map[string]any{"type": "get_state"}, cmdTimeout)
	if err != nil {
		go proc.Close()
		return nil, fmt.Errorf("pi start: %w: %s", err, proc.StderrTail())
	}
	pimuEvent(stream, map[string]any{"type": "proc_state", "state": "ready"})
	h.Broadcast(map[string]any{"type": "proc_state", "id": id, "state": "ready"})
	return r, nil
}

func (h *Hub) onEvent(r *Run, s *Stream, line []byte) {
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(line, &head)
	switch head.Type {
	case "agent_start":
		r.mu.Lock()
		r.streaming = true
		r.mu.Unlock()
		h.Broadcast(map[string]any{"type": "proc_state", "id": r.ID, "state": "streaming"})
	case "agent_settled":
		r.mu.Lock()
		r.streaming = false
		r.lastActive = time.Now()
		r.mu.Unlock()
		h.Broadcast(map[string]any{"type": "proc_state", "id": r.ID, "state": "ready"})
	}
	s.publish("pi", line)
}

func (h *Hub) watch(r *Run, s *Stream) {
	<-r.proc.Done()
	h.mu.Lock()
	if h.runs[r.ID] == r {
		delete(h.runs, r.ID)
	}
	h.mu.Unlock()
	lock.Release(h.cfg.AgentDir, r.ID)
	code := r.proc.ExitCode()
	slog.Info("pi exited", "session", r.ID, "code", code)
	ev := map[string]any{"type": "proc_state", "state": "exited", "code": code}
	if code != 0 {
		ev["stderrTail"] = r.proc.StderrTail()
	}
	pimuEvent(s, ev)
	pimuEvent(s, map[string]any{"type": "lock", "holder": "none"})
	h.Broadcast(map[string]any{"type": "proc_state", "id": r.ID, "state": "exited", "code": code})
}

// ChildEnv is Pimu's environment minus everything pi must not inherit: every
// PIMU_* variable (the login token, Telegram token, ...). pi's tools pass the
// environment on to the commands the model runs, so it must hold no secret.
func ChildEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if !strings.HasPrefix(kv, "PIMU_") {
			out = append(out, kv)
		}
	}
	return out
}

// Broadcast publishes a pimu event on the global stream.
func (h *Hub) Broadcast(v any) { pimuEvent(h.Global, v) }

// Done is closed when the run's pi process exits.
func (r *Run) Done() <-chan struct{} { return r.proc.Done() }

func pimuEvent(s *Stream, v any) {
	b, _ := json.Marshal(v)
	s.publish("pimu", b)
}

// Call sends a command to the session's pi process. Three consecutive
// timeouts kill the process.
func (h *Hub) Call(ctx context.Context, r *Run, cmd map[string]any, timeout time.Duration) (pirpc.Response, error) {
	r.touch()
	resp, err := r.proc.Call(ctx, cmd, timeout)
	r.mu.Lock()
	if errors.Is(err, context.DeadlineExceeded) {
		r.timeouts++
		err = ErrTimeout
	} else if err == nil {
		r.timeouts = 0
	}
	kill := r.timeouts >= 3
	r.mu.Unlock()
	if kill {
		slog.Warn("pi unresponsive, killing", "session", r.ID)
		go r.proc.Close()
	}
	return resp, err
}

func (h *Hub) Send(r *Run, v any) error {
	r.touch()
	return r.proc.Send(v)
}

// Release stops the session's pi process (aborting a run first) and frees the lock.
func (h *Hub) Release(ctx context.Context, id string) {
	r := h.Running(id)
	if r == nil {
		return
	}
	if r.Streaming() {
		_, _ = h.Call(ctx, r, map[string]any{"type": "abort"}, 60*time.Second)
	}
	r.proc.Close()
}

// Reap closes idle processes until ctx is done.
func (h *Hub) Reap(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		h.mu.Lock()
		var idle []*Run
		for _, r := range h.runs {
			r.mu.Lock()
			if !r.streaming && time.Since(r.lastActive) > h.cfg.IdleTimeout {
				idle = append(idle, r)
			}
			r.mu.Unlock()
		}
		h.mu.Unlock()
		for _, r := range idle {
			slog.Info("reaping idle pi", "session", r.ID)
			go r.proc.Close()
		}
	}
}

// Shutdown closes every process in parallel.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	var wg sync.WaitGroup
	for _, r := range h.runs {
		wg.Add(1)
		go func() { defer wg.Done(); r.proc.Close() }()
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
	}
}

// Models lists available models via a short-lived --no-session pi, cached 10m.
func (h *Hub) Models(ctx context.Context) (json.RawMessage, error) {
	h.modelsMu.Lock()
	defer h.modelsMu.Unlock()
	if h.models != nil && time.Since(h.modelsAt) < 10*time.Minute {
		return h.models, nil
	}
	data, err := h.Query(ctx, "get_available_models")
	if err != nil {
		return nil, err
	}
	h.models, h.modelsAt = data, time.Now()
	return data, nil
}

// ForgetModels drops the cached model list (after pi's config changed).
func (h *Hub) ForgetModels() {
	h.modelsMu.Lock()
	h.models = nil
	h.modelsMu.Unlock()
}

// Query runs one read-only RPC command (e.g. get_commands) in a throwaway pi
// started in $HOME, so it reflects the user-level configuration.
func (h *Hub) Query(ctx context.Context, typ string) (json.RawMessage, error) {
	home, _ := os.UserHomeDir()
	p, err := pirpc.Start(h.cfg.PiBin, []string{"--mode", "rpc", "--no-session"}, home, ChildEnv(os.Environ()), func([]byte) {})
	if err != nil {
		return nil, err
	}
	defer p.Close()
	resp, err := p.Call(ctx, map[string]any{"type": typ}, cmdTimeout)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", typ, err)
	}
	if !resp.Success {
		return nil, errors.New(resp.Error)
	}
	return resp.Data, nil
}
