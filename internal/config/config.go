// Package config reads Pimu settings from the environment.
package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr        string
	Token       string
	PublicURL   string
	PiBin       string
	PiArgs      []string
	Workdirs    []string
	IdleTimeout time.Duration
	MaxProcs    int
	MaxJobs     int // background jobs (pimu_task) running at once
	LogLevel    string
	AgentDir    string // $PI_CODING_AGENT_DIR or ~/.pi/agent
	SessionDir  string // $PI_CODING_AGENT_SESSION_DIR or <AgentDir>/sessions
	DataDir     string // pimu.db lives here
	TGToken     string // Telegram bot token; empty disables notifications
	TGChatID    string
	// Cloudflare Access: both set turns on JWT checks for every request.
	CFAccessTeam   string
	CFAccessAUD    string
	CFAccessEmails []string // optional allowlist: emails or service token client IDs
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// Load reads and validates the environment. requireToken is false for
// subcommands that do not serve HTTP.
func Load(requireToken bool) (*Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("home dir: %w", err)
	}
	c := &Config{
		Addr:      env("PIMU_ADDR", "127.0.0.1:7777"),
		Token:     os.Getenv("PIMU_TOKEN"),
		PublicURL: strings.TrimRight(env("PIMU_PUBLIC_URL", ""), "/"),
		PiBin:     env("PIMU_PI_BIN", "pi"),
		PiArgs:    strings.Fields(env("PIMU_PI_ARGS", "")),
		LogLevel:  env("PIMU_LOG_LEVEL", "info"),
		AgentDir:  expand(env("PI_CODING_AGENT_DIR", filepath.Join(home, ".pi", "agent")), home),
	}
	c.DataDir = expand(env("PIMU_DATA_DIR", filepath.Join(home, ".local", "share", "pimu")), home)
	c.TGToken, c.TGChatID = os.Getenv("PIMU_TELEGRAM_TOKEN"), env("PIMU_TELEGRAM_CHAT_ID", "")
	c.CFAccessTeam, c.CFAccessAUD = env("PIMU_CF_ACCESS_TEAM", ""), env("PIMU_CF_ACCESS_AUD", "")
	if (c.CFAccessTeam == "") != (c.CFAccessAUD == "") {
		return nil, fmt.Errorf("set both PIMU_CF_ACCESS_TEAM and PIMU_CF_ACCESS_AUD, or neither")
	}
	for _, e := range strings.Split(env("PIMU_CF_ACCESS_EMAILS", ""), ",") {
		if e = strings.TrimSpace(e); e != "" {
			c.CFAccessEmails = append(c.CFAccessEmails, e)
		}
	}
	c.SessionDir = expand(env("PI_CODING_AGENT_SESSION_DIR", filepath.Join(c.AgentDir, "sessions")), home)
	if requireToken && len(c.Token) < 32 {
		return nil, fmt.Errorf("PIMU_TOKEN must be at least 32 characters (try: openssl rand -hex 32)")
	}
	for _, d := range strings.Split(env("PIMU_WORKDIRS", home), ",") {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		abs, err := filepath.Abs(expand(d, home))
		if err != nil {
			return nil, fmt.Errorf("PIMU_WORKDIRS %q: %w", d, err)
		}
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			abs = real
		}
		c.Workdirs = append(c.Workdirs, abs)
	}
	if c.IdleTimeout, err = time.ParseDuration(env("PIMU_IDLE_TIMEOUT", "10m")); err != nil {
		return nil, fmt.Errorf("PIMU_IDLE_TIMEOUT: %w", err)
	}
	if c.MaxProcs, err = strconv.Atoi(env("PIMU_MAX_PROCS", "3")); err != nil || c.MaxProcs < 1 {
		return nil, fmt.Errorf("PIMU_MAX_PROCS must be a positive integer")
	}
	if c.MaxJobs, err = strconv.Atoi(env("PIMU_MAX_JOBS", "1")); err != nil || c.MaxJobs < 1 {
		return nil, fmt.Errorf("PIMU_MAX_JOBS must be a positive integer")
	}
	return c, nil
}

func expand(p, home string) string {
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

// Loopback reports whether Addr binds only to a loopback interface.
func (c *Config) Loopback() bool {
	host, _, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// AllowedDir resolves dir and checks it is inside one of Workdirs.
func (c *Config) AllowedDir(dir string) (string, bool) {
	abs, err := filepath.Abs(filepath.Clean(dir))
	if err != nil {
		return "", false
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", false
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", false
	}
	for _, w := range c.Workdirs {
		if real == w || strings.HasPrefix(real, w+string(filepath.Separator)) {
			return real, true
		}
	}
	return "", false
}
