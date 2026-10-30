package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const cookieName = "pimu"
const cookieTTL = 30 * 24 * time.Hour

func (s *Server) sign(exp int64) string {
	m := hmac.New(sha256.New, []byte(s.cfg.Token))
	m.Write([]byte(strconv.FormatInt(exp, 10)))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *Server) authed(r *http.Request) bool {
	if b, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return subtle.ConstantTimeCompare([]byte(b), []byte(s.cfg.Token)) == 1
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	expStr, sig, ok := strings.Cut(c.Value, ".")
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if !ok || err != nil || time.Now().Unix() > exp {
		return false
	}
	return hmac.Equal([]byte(sig), []byte(s.sign(exp)))
}

func (s *Server) setCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: strings.HasPrefix(s.cfg.PublicURL, "https://"),
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "登录尝试过多，请一分钟后再试")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Token), []byte(s.cfg.Token)) != 1 {
		writeErr(w, http.StatusUnauthorized, "bad_token", "token 不正确")
		return
	}
	exp := time.Now().Add(cookieTTL).Unix()
	s.setCookie(w, strconv.FormatInt(exp, 10)+"."+s.sign(exp), int(cookieTTL.Seconds()))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.setCookie(w, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// guard enforces auth and CSRF rules for /api routes.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Webhooks (?k= secret or HMAC signature) and pimu-agent.ts (internal token) authenticate
		// in their handlers; webhooks may post any content type.
		hook := isHook(r.URL.Path)
		internal := strings.HasPrefix(r.URL.Path, "/api/internal/")
		if hook || internal {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			// JSON (or, for uploads, a custom header) forces a CORS preflight,
			// so a cross-site form cannot post with the session cookie.
			upload := strings.HasSuffix(r.URL.Path, "/files") && r.Header.Get("X-Pimu-Upload") == "1"
			if !upload && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				writeErr(w, http.StatusUnsupportedMediaType, "json_required", "需要 Content-Type: application/json")
				return
			}
			if o := r.Header.Get("Origin"); s.cfg.PublicURL != "" && o != "" && o != s.cfg.PublicURL {
				writeErr(w, http.StatusForbidden, "bad_origin", "Origin 不匹配")
				return
			}
		}
		switch r.URL.Path {
		case "/api/health", "/api/login":
		default:
			if !s.authed(r) {
				writeErr(w, http.StatusUnauthorized, "unauthorized", "请先登录")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("Cf-Connecting-Ip"); ip != "" {
		return ip
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

// limiter allows 5 attempts per minute per key.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	var keep []time.Time
	for _, t := range l.hits[key] {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	if len(keep) >= 5 {
		l.hits[key] = keep
		return false
	}
	l.hits[key] = append(keep, now)
	return true
}
