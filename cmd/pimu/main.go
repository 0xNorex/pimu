// Command pimu: Not another agent harness. Just Pi, everywhere.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/0xNorex/pimu/internal/caps"
	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/goals"
	"github.com/0xNorex/pimu/internal/httpapi"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/jobs"
	"github.com/0xNorex/pimu/internal/notify"
	"github.com/0xNorex/pimu/internal/store"
	"github.com/0xNorex/pimu/internal/tasks"
	"github.com/0xNorex/pimu/web"
)

var version = "0.1.0-dev"

const usage = `usage: pimu <command>

  serve          run the server (config via PIMU_* env, see README)
  release <id>   stop Pimu's pi process for a session and free its lock
  version        print version`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve()
	case "release":
		if len(os.Args) != 3 {
			err = errors.New("usage: pimu release <session-id>")
		} else {
			err = release(os.Args[2])
		}
	case "version", "--version", "-v":
		fmt.Println("pimu", version)
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "pimu:", err)
		os.Exit(1)
	}
}

func serve() error {
	cfg, err := config.Load(true)
	if err != nil {
		return err
	}
	scrubSelf()
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))
	if !cfg.Loopback() {
		slog.Warn("PIMU_ADDR is not loopback: Pimu is reachable without Cloudflare Access", "addr", cfg.Addr)
	}

	piVersion := ""
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	if out, err := exec.CommandContext(ctx, cfg.PiBin, "--version").Output(); err == nil {
		piVersion = strings.TrimSpace(string(out))
	} else {
		slog.Warn("pi --version failed", "bin", cfg.PiBin, "err", err)
	}
	cancel()

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer st.Close()
	h := hub.New(cfg)
	// A bot is a pi session; its persona rides on --append-system-prompt and
	// its name on --name until pi has recorded it.
	tg := notify.Telegram{Token: cfg.TGToken, ChatID: cfg.TGChatID}
	tk := tasks.New(st, h, tg, cfg.PublicURL)
	gs := goals.New(st, h, tk, tg, cfg.DataDir, cfg.PublicURL, cfg.Addr)
	js := jobs.New(st, h, cfg.MaxJobs)
	js.Alert = gs.Alert
	js.BotEnv = func(bot string) []string {
		return []string{"PIMU_BOT_DIR=" + gs.BotDir(bot), "PIMU_API=http://" + cfg.Addr}
	}
	cp, err := caps.New(filepath.Join(cfg.DataDir, "run"))
	if err != nil {
		return err
	}
	h.SpawnEnv = func(id string) []string {
		sc, ok := js.Scope(id)
		if !ok {
			sc, ok = gs.Scope(id)
		}
		if !ok {
			return nil
		}
		kv, err := cp.Issue(sc)
		if err != nil {
			slog.Error("issue capability", "session", id, "err", err)
			return nil
		}
		return []string{kv}
	}
	h.Lookup = func(id string) (string, []string, []string, bool) {
		if args, env, ok := js.Extras(id); ok { // background job: fresh session in the bot's cwd
			return "", args, env, false
		}
		args, env := gs.Extras(id) // PIMU_* for bots, heartbeats and goal subtasks
		b, err := st.Bot(id)
		if err != nil {
			return "", args, env, false
		}
		if b.Persona != "" {
			args = append(args, "--append-system-prompt", b.Persona)
		}
		if info, ok := h.Idx.Find(id); !ok || info.Name != b.Name {
			args = append(args, "--name", b.Name)
		}
		return b.Cwd, args, env, true
	}
	api := httpapi.New(cfg, h, st, tk, gs, js, version, piVersion)
	api.Caps = cp
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(web.FS()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go h.Reap(ctx)
	if err := tk.Start(ctx); err != nil {
		return fmt.Errorf("tasks: %w", err)
	}
	gs.Start(ctx)
	js.Start(ctx)

	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("pimu listening", "addr", cfg.Addr, "version", version, "pi", piVersion)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx) // SSE streams never finish on their own; the timeout cuts them
	tk.Stop()
	h.Shutdown()
	return nil
}

// release asks the running server to free a session.
func release(id string) error {
	cfg, err := config.Load(true)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, "http://"+cfg.Addr+"/api/sessions/"+id+"/release", strings.NewReader("{}"))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("is pimu serve running? %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("release failed: HTTP %d", resp.StatusCode)
	}
	fmt.Println("released", id)
	return nil
}

// scrubSelf keeps Pimu's own secrets away from the processes it starts and
// from same-user processes (the commands a model runs): every PIMU_* variable
// is dropped from the environment children inherit, and the process is made
// non-dumpable so /proc/<pimu>/environ and /proc/<pimu>/mem (which still hold
// the original environment, e.g. PIMU_TOKEN) are readable only by root.
func scrubSelf() {
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "PIMU_") {
			_ = os.Unsetenv(k)
		}
	}
	const prSetDumpable = 4
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); e != 0 {
		slog.Warn("prctl(PR_SET_DUMPABLE, 0) failed", "err", e)
	}
}
