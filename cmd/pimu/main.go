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
	"strings"
	"syscall"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/httpapi"
	"github.com/0xNorex/pimu/internal/hub"
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

	h := hub.New(cfg)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.New(cfg, h, version, piVersion).Handler(web.FS()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go h.Reap(ctx)

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
