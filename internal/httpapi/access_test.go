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

	tok := "Bearer " + strings.Repeat("t", 32)
	cases := []struct {
		name, method, path string
		hdr                map[string]string
		want               int
	}{
		{"nothing", "GET", "/api/sessions", nil, 401},
		{"wrong aud", "GET", "/api/sessions", map[string]string{cfaccess.Header: sign("aud-2")}, 401},
		{"access alone is enough", "GET", "/api/bots", map[string]string{cfaccess.Header: sign("aud-1")}, 200},
		{"access cookie fallback", "GET", "/api/bots", map[string]string{"Cookie": cfaccess.Cookie + "=" + sign("aud-1")}, 200},
		{"token alone is enough", "GET", "/api/bots", map[string]string{"Authorization": tok}, 200},
		{"bad access, good token", "GET", "/api/bots", map[string]string{cfaccess.Header: sign("aud-2"), "Authorization": tok}, 200},
		{"health is public", "GET", "/api/health", nil, 200},
		{"hook with ?k", "POST", hookPath + "?k=" + g.HookSecret, map[string]string{"X-Pimu-Dedup": "d0"}, 200},
		{"hook with bad ?k", "POST", hookPath + "?k=nope", nil, 403},
		{"hook with bad signature", "POST", hookPath, map[string]string{"X-Pimu-Signature": "sha256=00"}, 403},
		{"hook with good signature", "POST", hookPath, map[string]string{"X-Pimu-Signature": goodSig, "X-Pimu-Dedup": "d1"}, 200},
		{"hook github header", "POST", hookPath, map[string]string{"X-Hub-Signature-256": goodSig, "X-GitHub-Delivery": "d2"}, 200},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range c.hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != c.want {
			t.Errorf("%s: %d, want %d (%s)", c.name, w.Code, c.want, strings.TrimSpace(w.Body.String()))
		}
	}
	status := func(hdr map[string]string) map[string]any {
		req := httptest.NewRequest("GET", "/api/auth/status", nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	if st := status(map[string]string{cfaccess.Header: sign("aud-1")}); st["authed"] != true || st["via"] != "access" {
		t.Errorf("status with access: %v", st)
	}
	if st := status(nil); st["authed"] != false || st["token"] != true || st["access"] != true {
		t.Errorf("status anonymous: %v", st)
	}
}

func TestAccessOnlyNoToken(t *testing.T) {
	r, sign := accessRig(t)
	r.s.cfg.Token = ""
	h := r.s.Handler(os.DirFS(t.TempDir()))
	do := func(method, path, body string, hdr map[string]string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	if c := do("GET", "/api/bots", "", map[string]string{cfaccess.Header: sign("aud-1")}); c != 200 {
		t.Errorf("access only: %d", c)
	}
	// An empty token must never match an empty Bearer or log in.
	if c := do("GET", "/api/bots", "", map[string]string{"Authorization": "Bearer "}); c != 401 {
		t.Errorf("empty bearer: %d", c)
	}
	if c := do("POST", "/api/login", `{"token":""}`, nil); c != 403 {
		t.Errorf("login without PIMU_TOKEN: %d", c)
	}
}

func TestAccessOffByDefault(t *testing.T) {
	r := newRig(t)
	if code, _ := r.do(t, "GET", "/api/health", "", ""); code != 200 {
		t.Fatalf("health without access config: %d", code)
	}
}
