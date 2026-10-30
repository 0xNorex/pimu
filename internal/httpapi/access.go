package httpapi

import (
	"net/http"
	"strings"
)

func isHook(p string) bool {
	return strings.HasPrefix(p, "/api/goals/") && strings.HasSuffix(p, "/hook")
}

// hookSignature returns "sha256=<hex>" from X-Pimu-Signature or GitHub's
// X-Hub-Signature-256.
func hookSignature(r *http.Request) string {
	if v := r.Header.Get("X-Pimu-Signature"); v != "" {
		return v
	}
	return r.Header.Get("X-Hub-Signature-256")
}
