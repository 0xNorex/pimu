package pirpc

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/fakepi"
)

func TestMain(m *testing.M) {
	fakepi.Run()
	os.Exit(m.Run())
}

func start(t *testing.T) (*Proc, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var events []string
	p, err := Start(os.Args[0], nil, t.TempDir(), append(os.Environ(), "FAKEPI=1"), func(line []byte) {
		var m struct{ Type string }
		_ = json.Unmarshal(line, &m)
		mu.Lock()
		events = append(events, m.Type)
		mu.Unlock()
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), events...) }
}

func TestCallCorrelatesResponses(t *testing.T) {
	p, _ := start(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := p.Call(ctx, map[string]any{"type": "get_state"}, 5*time.Second)
			if err != nil || !r.Success || r.Command != "get_state" || !strings.Contains(string(r.Data), "sessionFile") {
				t.Errorf("get_state: %+v %v", r, err)
			}
		}()
	}
	wg.Wait()
}

func TestPromptEventsAndLargeFrames(t *testing.T) {
	p, events := start(t)
	big := strings.Repeat("x", 200_000) // one JSONL frame well over bufio's 64 KB default
	if r, err := p.Call(context.Background(), map[string]any{"type": "prompt", "message": big}, 5*time.Second); err != nil || !r.Success {
		t.Fatalf("prompt: %+v %v", r, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !contains(events(), "agent_settled") {
		if time.Now().After(deadline) {
			t.Fatalf("no agent_settled; events %v", events())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if ev := events(); !contains(ev, "message_end") || contains(ev, "response") {
		t.Fatalf("events must be uncorrelated lines only: %v", ev)
	}
	r, err := p.Call(context.Background(), map[string]any{"type": "get_last_assistant_text"}, 5*time.Second)
	if err != nil || !strings.Contains(string(r.Data), "echo: xxx") {
		t.Fatalf("last text: %v", err)
	}
}

func TestCloseAndTimeout(t *testing.T) {
	p, _ := start(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Call(ctx, map[string]any{"type": "get_state"}, time.Second); err == nil {
		t.Fatal("cancelled ctx must fail the call")
	}
	p.Close()
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not stop the process")
	}
	if _, err := p.Call(context.Background(), map[string]any{"type": "get_state"}, time.Second); err == nil {
		t.Fatal("call after exit must fail")
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
