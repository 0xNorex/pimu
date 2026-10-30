package httpapi

import (
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/0xNorex/pimu/internal/cfaccess"
)

// requireAccess checks the Cloudflare Access token on every request when
// PIMU_CF_ACCESS_* is set. It sits in front of Pimu's own token auth, which
// stays as the second factor. Exceptions:
//   - local calls (loopback peer, no Cf-Connecting-Ip, which the Cloudflare
//     edge always adds) to /api/internal/ (pi children, capability auth) and
//     /api/health;
//   - goal webhooks that carry an HMAC signature header; the handler verifies it.
func (s *Server) requireAccess(next http.Handler) http.Handler {
	if s.access == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if local(r) && (strings.HasPrefix(p, "/api/internal/") || p == "/api/health") {
			next.ServeHTTP(w, r)
			return
		}
		_, err := s.access.Verify(r.Context(), cfaccess.Token(r))
		if err == nil {
			next.ServeHTTP(w, r)
			return
		}
		if isHook(p) && hookSignature(r) != "" {
			next.ServeHTTP(w, r)
			return
		}
		slog.Warn("cloudflare access denied", "path", p, "ip", clientIP(r), "err", err.Error())
		writeErr(w, http.StatusForbidden, "access_denied", "Cloudflare Access 校验失败")
	})
}

func local(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return err == nil && ip != nil && ip.IsLoopback() && r.Header.Get("Cf-Connecting-Ip") == ""
}

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
