package hub

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/caps"
	"github.com/0xNorex/pimu/internal/config"
	"github.com/0xNorex/pimu/internal/fakepi"
)

func TestMain(m *testing.M) {
	fakepi.Run()
	os.Exit(m.Run())
}

func TestChildEnvDropsPimu(t *testing.T) {
	got := ChildEnv([]string{"PATH=/bin", "PIMU_TOKEN=s", "PIMU_TG_TOKEN=t", "PIMU_INTERNAL_TOKEN=x", "HOME=/h", "XPIMU_OK=1"})
	if strings.Join(got, ",") != "PATH=/bin,HOME=/h,XPIMU_OK=1" {
		t.Fatalf("%v", got)
	}
}

// A pi started by the hub sees no Pimu secret, only a cap file it can read once.
func TestSpawnEnvHasNoSecrets(t *testing.T) {
	tmp := t.TempDir()
	dump := filepath.Join(tmp, "env")
	t.Setenv("FAKEPI", "1")
	t.Setenv("FAKEPI_ENV", dump)
	t.Setenv("PIMU_TOKEN", "server-secret-token")
	t.Setenv("PIMU_TG_TOKEN", "tg-secret")
	reg, err := caps.New(filepath.Join(tmp, "run"))
	if err != nil {
		t.Fatal(err)
	}
	h := New(&config.Config{PiBin: os.Args[0], AgentDir: filepath.Join(tmp, "agent"), SessionDir: filepath.Join(tmp, "sessions"), MaxProcs: 4, IdleTimeout: time.Minute})
	h.SpawnEnv = func(id string) []string {
		kv, _ := reg.Issue(caps.Scope{Session: id, Bot: "pm-x", Job: 1})
		return []string{kv}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := h.CreateWithID(ctx, "pimu-j1", tmp); err != nil {
		t.Fatal(err)
	}
	defer h.Shutdown()
	b, err := os.ReadFile(dump)
	if err != nil {
		t.Fatal(err)
	}
	env := string(b)
	for _, secret := range []string{"server-secret-token", "tg-secret", "PIMU_TOKEN", "PIMU_INTERNAL_TOKEN"} {
		if strings.Contains(env, secret) {
			t.Fatalf("child env leaks %q", secret)
		}
	}
	if !strings.Contains(env, "PIMU_LOCK_OWNER=pimu-j1") || !strings.Contains(env, "PIMU_CAP_FILE=") {
		t.Fatalf("missing expected env:\n%s", env)
	}
	_, tok, _ := strings.Cut(env, "\nCAP=")
	if sc, ok := reg.Check(tok); !ok || sc.Job != 1 {
		t.Fatalf("cap file token does not check out")
	}
}
