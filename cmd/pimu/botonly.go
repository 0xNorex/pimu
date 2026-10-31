package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/hub"
	"github.com/0xNorex/pimu/internal/store"
)

// ensureAssistant creates the built-in 助手 bot on first start (docs/DESIGN.md:
// Pimu shows only bots; 助手 is where ad-hoc questions go).
func ensureAssistant(st *store.Store, cfg *config.Config) error {
	if _, err := st.Bot(store.AssistantID); !errors.Is(err, store.ErrNotFound) {
		return err
	}
	cwd := ""
	if len(cfg.Workdirs) > 0 {
		cwd = cfg.Workdirs[0]
	}
	_, err := st.CreateBot(store.Bot{SessionID: store.AssistantID, Name: "助手", Description: "随手问的问题", Cwd: cwd})
	if err == nil {
		slog.Info("created the built-in assistant bot")
	}
	return err
}

// background runs (task runs, heartbeats, jobs) stay where they are: their
// task, goal or job links to them.
var background = regexp.MustCompile(`^pimu-[tgj]\d`)

// pendingFile lists the plain sessions still to move into 助手. It is written
// once, on the first start of a Bot-only Pimu, so sessions a terminal pi
// creates later are left alone; ids that could not move (open in a terminal
// pi, replying) stay listed and are retried by sweep.
func pendingFile(cfg *config.Config) string { return filepath.Join(cfg.DataDir, "migrate-plain.json") }

func planMigration(cfg *config.Config, st *store.Store, h *hub.Hub) error {
	path := pendingFile(cfg)
	if _, err := os.Stat(path); err == nil || !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ids := []string{}
	for _, i := range h.Idx.List() {
		if h.InBotDir(i.Path) || background.MatchString(i.ID) {
			continue
		}
		if _, err := st.Bot(i.ID); err == nil {
			continue // a bot from before V14: MoveToBotDir handles it
		}
		ids = append(ids, i.ID)
	}
	slog.Info("plain sessions to move into the assistant", "count", len(ids))
	return writePending(path, ids)
}

func writePending(path string, ids []string) error {
	b, _ := json.Marshal(ids)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// sweep moves bot session files into the bots dir and the plain sessions of
// planMigration into 助手's topics, at start and then every minute, which
// picks up whatever was busy the last time.
func sweep(ctx context.Context, cfg *config.Config, st *store.Store, h *hub.Hub) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		bots, err := st.Bots()
		if err != nil {
			slog.Error("bot sessions", "err", err)
		}
		for _, b := range bots {
			if dropDraft(st, h, b, time.Hour) {
				continue
			}
			if _, err := h.MoveToBotDir(b.SessionID); err != nil && !busy(err) {
				slog.Warn("move bot session", "session", b.SessionID, "err", err)
			}
		}
		migratePlain(cfg, h)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// dropDraft deletes a bot made with '+' that never got a message (no name, no
// conversation file) once it is older than ttl, so abandoned drafts don't pile up.
func dropDraft(st *store.Store, h *hub.Hub, b store.Bot, ttl time.Duration) bool {
	if b.Name != "" || b.SessionID == store.AssistantID || h.Running(b.SessionID) != nil {
		return false
	}
	if t, err := time.Parse(time.RFC3339Nano, b.CreatedAt); err != nil || time.Since(t) < ttl {
		return false
	}
	if files, _ := filepath.Glob(filepath.Join(h.BotSessionDir(b.SessionID), "*.jsonl")); len(files) > 0 {
		return false
	}
	if err := st.DeleteBot(b.SessionID); err != nil {
		slog.Warn("drop draft bot", "bot", b.SessionID, "err", err)
		return false
	}
	_ = os.RemoveAll(filepath.Dir(h.BotSessionDir(b.SessionID)))
	return true
}

func busy(err error) bool { return errors.Is(err, hub.ErrStreaming) || errors.Is(err, hub.ErrLocked) }

func migratePlain(cfg *config.Config, h *hub.Hub) {
	path := pendingFile(cfg)
	b, err := os.ReadFile(path)
	if err != nil {
		slog.Error("plain session migration", "err", err)
		return
	}
	var ids []string
	if err := json.Unmarshal(b, &ids); err != nil || len(ids) == 0 {
		return
	}
	left := []string{}
	for _, id := range ids {
		if _, err := h.MoveInto(store.AssistantID, id); err != nil {
			if !busy(err) {
				slog.Warn("move plain session", "session", id, "err", err)
			}
			left = append(left, id) // retried next round
		}
	}
	slog.Info("plain sessions moved into the assistant", "moved", len(ids)-len(left), "left", len(left))
	if err := writePending(path, left); err != nil {
		slog.Error("plain session migration", "err", err)
	}
}
