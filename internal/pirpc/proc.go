// Package pirpc runs one `pi --mode rpc` child process and speaks its
// strict-JSONL protocol: commands on stdin, responses and events on stdout.
package pirpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var ErrExited = errors.New("pi process exited")

type Response struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type Proc struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	wmu     sync.Mutex
	seq     atomic.Uint64
	pmu     sync.Mutex
	pending map[string]chan Response
	done    chan struct{}
	code    int
	tail    *lineTail
}

// Start spawns pi. onEvent receives every stdout line that is not a
// correlated response, unchanged, from a single reader goroutine.
func Start(bin string, args []string, dir string, env []string, onEvent func(line []byte)) (*Proc, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	p := &Proc{cmd: cmd, stdin: stdin, pending: map[string]chan Response{}, done: make(chan struct{}), tail: &lineTail{max: 50}}
	cmd.Stderr = p.tail
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", bin, err)
	}
	go p.read(stdout, onEvent)
	return p, nil
}

func (p *Proc) read(stdout io.Reader, onEvent func([]byte)) {
	r := bufio.NewReaderSize(stdout, 64*1024)
	for {
		line, err := r.ReadBytes('\n') // split on LF only; never on U+2028/2029
		line = bytes.TrimRight(line, "\r\n")
		if len(line) > 0 {
			p.dispatch(line, onEvent)
		}
		if err != nil {
			break
		}
	}
	werr := p.cmd.Wait()
	p.code = p.cmd.ProcessState.ExitCode()
	if werr != nil && p.code == 0 {
		p.code = -1
	}
	p.pmu.Lock()
	for id, ch := range p.pending {
		close(ch)
		delete(p.pending, id)
	}
	p.pmu.Unlock()
	close(p.done)
}

func (p *Proc) dispatch(line []byte, onEvent func([]byte)) {
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(line, &head) != nil {
		slog.Warn("pi stdout: invalid json", "bytes", len(line))
		return
	}
	if head.Type == "response" {
		p.pmu.Lock()
		ch, ok := p.pending[head.ID]
		delete(p.pending, head.ID)
		p.pmu.Unlock()
		if ok {
			var resp Response
			_ = json.Unmarshal(line, &resp)
			ch <- resp
		} else {
			slog.Warn("pi stdout: uncorrelated response", "id", head.ID)
		}
		return
	}
	onEvent(line)
}

// Call sends cmd (a JSON object; "id" is assigned) and waits for its response.
func (p *Proc) Call(ctx context.Context, cmd map[string]any, timeout time.Duration) (Response, error) {
	id := "r" + strconv.FormatUint(p.seq.Add(1), 10)
	cmd["id"] = id
	ch := make(chan Response, 1)
	p.pmu.Lock()
	p.pending[id] = ch
	p.pmu.Unlock()
	if err := p.Send(cmd); err != nil {
		p.pmu.Lock()
		delete(p.pending, id)
		p.pmu.Unlock()
		return Response{}, err
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case resp, ok := <-ch:
		if !ok {
			return Response{}, ErrExited
		}
		return resp, nil
	case <-t.C:
	case <-ctx.Done():
	}
	p.pmu.Lock()
	delete(p.pending, id)
	p.pmu.Unlock()
	if ctx.Err() != nil {
		return Response{}, ctx.Err()
	}
	return Response{}, context.DeadlineExceeded
}

// Send writes one JSONL record without waiting for a response.
func (p *Proc) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	select {
	case <-p.done:
		return ErrExited
	default:
	}
	_, err = p.stdin.Write(append(b, '\n'))
	return err
}

// Close asks pi to exit by closing stdin, then escalates to signals.
func (p *Proc) Close() {
	p.wmu.Lock()
	_ = p.stdin.Close()
	p.wmu.Unlock()
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		select {
		case <-p.done:
			return
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-p.cmd.Process.Pid, sig)
		}
	}
	<-p.done
}

func (p *Proc) Done() <-chan struct{} { return p.done }
func (p *Proc) Pid() int              { return p.cmd.Process.Pid }

// ExitCode is valid after Done is closed.
func (p *Proc) ExitCode() int      { return p.code }
func (p *Proc) StderrTail() string { return p.tail.String() }

// lineTail keeps the last max lines written to it.
type lineTail struct {
	mu    sync.Mutex
	max   int
	lines []string
	part  []byte
}

func (t *lineTail) Write(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.part = append(t.part, b...)
	for {
		i := bytes.IndexByte(t.part, '\n')
		if i < 0 {
			break
		}
		line := string(t.part[:i])
		t.part = t.part[i+1:]
		slog.Debug("pi stderr", "line", line)
		t.lines = append(t.lines, line)
		if len(t.lines) > t.max {
			t.lines = t.lines[1:]
		}
	}
	return len(b), nil
}

func (t *lineTail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := ""
	for _, l := range t.lines {
		s += l + "\n"
	}
	return s + string(t.part)
}
