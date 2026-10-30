// Package fakepi is a stand-in for `pi --mode rpc` in tests. A test binary
// re-executes itself as pi:
//
//	func TestMain(m *testing.M) { fakepi.Run(); os.Exit(m.Run()) }
//
// and points config.PiBin at os.Args[0] with FAKEPI=1 in the environment
// (FAKEPI is not PIMU_*, so it survives hub.ChildEnv).
//
// Behaviour per prompt message:
//   - contains "SLEEP": the turn lasts until aborted (or 30s)
//   - contains "FAIL":  the assistant message ends with stopReason "error"
//   - otherwise: one assistant message "echo: <message>" (12 tokens)
//
// If FAKEPI_ENV is set, the process writes its environment (and the content
// of PIMU_CAP_FILE, if any) to that path at start.
package fakepi

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Run turns this process into the fake pi if FAKEPI=1; otherwise it returns.
func Run() {
	if os.Getenv("FAKEPI") != "1" {
		return
	}
	if p := os.Getenv("FAKEPI_ENV"); p != "" {
		dump := strings.Join(os.Environ(), "\n")
		if f := os.Getenv("PIMU_CAP_FILE"); f != "" {
			b, _ := os.ReadFile(f)
			dump += "\nCAP=" + string(b)
		}
		_ = os.WriteFile(p, []byte(dump), 0o600)
	}
	serve()
	os.Exit(0)
}

func serve() {
	var mu sync.Mutex
	out := json.NewEncoder(os.Stdout)
	emit := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		_ = out.Encode(v)
	}
	abort := make(chan struct{}, 1)
	last := ""
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<24)
	for in.Scan() {
		var c struct {
			Type    string `json:"type"`
			ID      string `json:"id"`
			Message string `json:"message"`
		}
		if json.Unmarshal(in.Bytes(), &c) != nil {
			continue
		}
		ok := func(data any) {
			emit(map[string]any{"type": "response", "id": c.ID, "command": c.Type, "success": true, "data": data})
		}
		switch c.Type {
		case "get_state":
			ok(map[string]any{"sessionFile": fmt.Sprintf("/tmp/fakepi-%d.jsonl", os.Getpid()), "isStreaming": false})
		case "get_last_assistant_text":
			mu.Lock()
			text := last
			mu.Unlock()
			ok(map[string]any{"text": text})
		case "abort":
			select {
			case abort <- struct{}{}:
			default:
			}
			ok(nil)
		case "prompt":
			ok(nil)
			msg := c.Message
			go func() {
				emit(map[string]any{"type": "agent_start"})
				stop, text := "stop", "echo: "+msg
				if strings.Contains(msg, "SLEEP") {
					select {
					case <-abort:
						stop, text = "aborted", ""
					case <-time.After(30 * time.Second):
					}
				}
				if strings.Contains(msg, "FAIL") {
					stop, text = "error", ""
				}
				mu.Lock()
				last = text
				mu.Unlock()
				emit(map[string]any{"type": "message_end", "message": map[string]any{
					"role": "assistant", "stopReason": stop, "errorMessage": map[bool]string{true: "fake failure"}[stop == "error"],
					"content": []any{map[string]any{"type": "text", "text": text}}, "usage": map[string]any{"totalTokens": 12}}})
				emit(map[string]any{"type": "agent_end"})
				emit(map[string]any{"type": "agent_settled"})
			}()
		default:
			ok(map[string]any{})
		}
	}
}
