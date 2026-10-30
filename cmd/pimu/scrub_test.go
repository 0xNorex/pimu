package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

const secret = "v9-test-secret-value"

func TestMain(m *testing.M) {
	if os.Getenv("SCRUB_CHILD") == "1" {
		scrubSelf()
		// A same-user process (what a model's bash command is) tries both ways in.
		own, _ := exec.Command("sh", "-c", "env; cat /proc/self/environ").CombinedOutput()
		parent, perr := exec.Command("cat", fmt.Sprintf("/proc/%d/environ", os.Getpid())).CombinedOutput()
		fmt.Printf("ENV=%v\nOWN=%q\nPARENT=%q ERR=%v\n", os.Getenv("PIMU_TOKEN") != "", own, parent, perr)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestScrubSelf(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "SCRUB_CHILD=1", "PIMU_TOKEN="+secret, "PIMU_TG_TOKEN="+secret)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	if !strings.Contains(s, "ENV=false") {
		t.Fatalf("PIMU_TOKEN still in Pimu's env:\n%s", s)
	}
	if strings.Count(s, secret) != 0 {
		t.Fatalf("secret readable by a child:\n%s", s)
	}
	if os.Geteuid() != 0 && !strings.Contains(s, "ERR=exit status") {
		t.Fatalf("/proc/<pimu>/environ must be unreadable once non-dumpable:\n%s", s)
	}
}
