package httpapi

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0xNorex/pimu/internal/cfaccess"
	"github.com/0xNorex/pimu/internal/store"
)

func accessRig(t *testing.T) (*rig, func(aud string) string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k1", "kty": "RSA", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	t.Cleanup(jwks.Close)
	r := newRig(t)
	r.s.cfg.Token = strings.Repeat("t", 32)
	r.s.access = cfaccess.New("myteam", "aud-1", nil)
	r.s.access.CertsURL = jwks.URL
	sign := func(aud string) string {
		h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "k1"})
		c, _ := json.Marshal(map[string]any{"iss": "https://myteam.cloudflareaccess.com", "aud": []string{aud}, "exp": time.Now().Add(time.Hour).Unix(), "email": "me@example.com"})
		in := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
		sum := sha256.Sum256([]byte(in))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
		return in + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	return r, sign
}

func TestCloudflareAccess(t *testing.T) {
	r, sign := accessRig(t)
	h := r.s.Handler(os.DirFS(t.TempDir()))
	g, err := r.st.CreateGoal(store.Goal{BotID: r.bot, Slug: "h", Title: "h", Level: 1, EverySec: 3600, DayTokens: 1000, HookSecret: "s3cret", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	hookPath := "/api/goals/" + strconv.FormatInt(g.ID, 10) + "/hook"
	body := `{"hello":1}`
	m := hmac.New(sha256.New, []byte(g.HookSecret))
	m.Write([]byte(body))
	goodSig := "sha256=" + hex.EncodeToString(m.Sum(nil))

	cases := []struct {
		name, method, path, remote string
		hdr                        map[string]string
		want                       int
	}{
		{"no token", "GET", "/api/sessions", "", nil, 403},
		{"static needs access too", "GET", "/", "", nil, 403},
		{"wrong aud", "GET", "/api/sessions", "", map[string]string{cfaccess.Header: sign("aud-2")}, 403},
		{"valid access, no pimu login", "GET", "/api/sessions", "", map[string]string{cfaccess.Header: sign("aud-1")}, 401},
		{"valid access + pimu token", "GET", "/api/bots", "", map[string]string{cfaccess.Header: sign("aud-1"), "Authorization": "Bearer " + strings.Repeat("t", 32)}, 200},
		{"cookie fallback", "GET", "/api/bots", "", map[string]string{"Cookie": cfaccess.Cookie + "=" + sign("aud-1"), "Authorization": "Bearer " + strings.Repeat("t", 32)}, 200},
		{"local health", "GET", "/api/health", "127.0.0.1:5555", nil, 200},
		{"tunnel health", "GET", "/api/health", "127.0.0.1:5555", map[string]string{"Cf-Connecting-Ip": "203.0.113.9"}, 403},
		{"local internal reaches cap auth", "POST", "/api/internal/approvals", "127.0.0.1:5555", nil, 403},
		{"local non-internal", "GET", "/api/sessions", "127.0.0.1:5555", nil, 403},
		{"hook with ?k only", "POST", hookPath + "?k=" + g.HookSecret, "", nil, 403},
		{"hook with bad signature", "POST", hookPath, "", map[string]string{"X-Pimu-Signature": "sha256=00"}, 403},
		{"hook with good signature", "POST", hookPath, "", map[string]string{"X-Pimu-Signature": goodSig}, 200},
		{"hook github header", "POST", hookPath, "", map[string]string{"X-Hub-Signature-256": goodSig, "X-GitHub-Delivery": "d2"}, 200},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if c.remote != "" {
			req.RemoteAddr = c.remote
		}
		for k, v := range c.hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != c.want {
			t.Errorf("%s: %d, want %d (%s)", c.name, w.Code, c.want, strings.TrimSpace(w.Body.String()))
		}
	}
	// The local internal call above got past Access: its 403 is the capability check.
	req := httptest.NewRequest("POST", "/api/internal/approvals", strings.NewReader(`{}`))
	req.RemoteAddr = "127.0.0.1:5555"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if strings.Contains(w.Body.String(), "access_denied") {
		t.Fatal("local internal call hit the Access check")
	}
}

func TestAccessOffByDefault(t *testing.T) {
	r := newRig(t)
	if code, _ := r.do(t, "GET", "/api/health", "", ""); code != 200 {
		t.Fatalf("health without access config: %d", code)
	}
}
