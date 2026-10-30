package cfaccess

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeIdP struct {
	key   *rsa.PrivateKey
	kid   string
	hits  atomic.Int32
	srv   *httptest.Server
	extra map[string]*rsa.PrivateKey // more published keys
}

func newIdP(t *testing.T) *fakeIdP {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{key: k, kid: "k1", extra: map[string]*rsa.PrivateKey{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		jwk := func(kid string, k *rsa.PrivateKey) map[string]string {
			return map[string]string{"kid": kid, "kty": "RSA", "alg": "RS256", "use": "sig",
				"n": base64.RawURLEncoding.EncodeToString(k.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.E)).Bytes())}
		}
		keys := []map[string]string{jwk(f.kid, f.key)}
		for kid, k := range f.extra {
			keys = append(keys, jwk(kid, k))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) sign(t *testing.T, k *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	c, _ := json.Marshal(claims)
	in := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return in + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func setup(t *testing.T, allow ...string) (*fakeIdP, *Verifier, map[string]any) {
	f := newIdP(t)
	v := New("myteam", "aud-1", allow)
	v.CertsURL = f.srv.URL
	claims := map[string]any{"iss": "https://myteam.cloudflareaccess.com", "aud": []string{"aud-1"},
		"exp": time.Now().Add(time.Hour).Unix(), "nbf": time.Now().Add(-time.Minute).Unix(), "email": "me@example.com"}
	return f, v, claims
}

func TestVerify(t *testing.T) {
	f, v, base := setup(t)
	with := func(k string, val any) map[string]any {
		c := map[string]any{}
		for a, b := range base {
			c[a] = b
		}
		if val == nil {
			delete(c, k)
		} else {
			c[k] = val
		}
		return c
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	cases := []struct {
		name, tok, want string
	}{
		{"valid", f.sign(t, f.key, "k1", base), ""},
		{"aud as string", f.sign(t, f.key, "k1", with("aud", "aud-1")), ""},
		{"wrong aud", f.sign(t, f.key, "k1", with("aud", []string{"aud-2"})), "audience"},
		{"expired", f.sign(t, f.key, "k1", with("exp", time.Now().Add(-2*time.Minute).Unix())), "expired"},
		{"within skew", f.sign(t, f.key, "k1", with("exp", time.Now().Add(-30*time.Second).Unix())), ""},
		{"no exp", f.sign(t, f.key, "k1", with("exp", nil)), "expired"},
		{"not yet", f.sign(t, f.key, "k1", with("nbf", time.Now().Add(5*time.Minute).Unix())), "not valid yet"},
		{"wrong iss", f.sign(t, f.key, "k1", with("iss", "https://evil.cloudflareaccess.com")), "issuer"},
		{"unknown kid", f.sign(t, f.key, "k9", base), "unknown key"},
		{"forged signature", f.sign(t, other, "k1", base), "bad signature"},
		{"missing", "", "no Access token"},
		{"garbage", "a.b", "malformed"},
	}
	for _, c := range cases {
		_, err := v.Verify(context.Background(), c.tok)
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%s: %v", c.name, err)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
	// alg none / HS256 must never pass.
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","kid":"k1"}`))
	p, _ := json.Marshal(base)
	if _, err := v.Verify(context.Background(), h+"."+base64.RawURLEncoding.EncodeToString(p)+"."); err == nil {
		t.Error("alg none accepted")
	}
}

func TestUnknownKidRefreshIsRateLimited(t *testing.T) {
	f, v, claims := setup(t)
	if _, err := v.Verify(context.Background(), f.sign(t, f.key, "k1", claims)); err != nil {
		t.Fatal(err)
	}
	// Rotation: a new key appears; the first token with its kid triggers one refetch.
	k2, _ := rsa.GenerateKey(rand.Reader, 2048)
	f.extra["k2"] = k2
	now := time.Now()
	v.Now = func() time.Time { return now.Add(time.Minute) }
	if _, err := v.Verify(context.Background(), f.sign(t, k2, "k2", claims)); err != nil {
		t.Fatalf("rotated key: %v", err)
	}
	hits := f.hits.Load()
	for range 20 {
		_, _ = v.Verify(context.Background(), f.sign(t, f.key, "bogus", claims))
	}
	if f.hits.Load() != hits {
		t.Fatalf("unknown kids refetched %d times within MinRefresh", f.hits.Load()-hits)
	}
}

func TestAllowlistAndCookie(t *testing.T) {
	f, v, claims := setup(t, "Me@Example.com", "svc-client.access")
	if _, err := v.Verify(context.Background(), f.sign(t, f.key, "k1", claims)); err != nil {
		t.Fatal(err)
	}
	claims["email"] = "someone@else.com"
	if _, err := v.Verify(context.Background(), f.sign(t, f.key, "k1", claims)); err == nil {
		t.Fatal("email outside allowlist accepted")
	}
	delete(claims, "email")
	claims["common_name"] = "svc-client.access"
	if _, err := v.Verify(context.Background(), f.sign(t, f.key, "k1", claims)); err != nil {
		t.Fatalf("service token: %v", err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: Cookie, Value: "c"})
	if Token(r) != "c" {
		t.Fatal("cookie fallback")
	}
	r.Header.Set(Header, "h")
	if Token(r) != "h" {
		t.Fatal("header wins")
	}
}

func TestTeamForms(t *testing.T) {
	for _, in := range []string{"myteam", "myteam.cloudflareaccess.com", "https://myteam.cloudflareaccess.com/"} {
		if v := New(in, "a", nil); v.Issuer != "https://myteam.cloudflareaccess.com" || v.CertsURL != v.Issuer+"/cdn-cgi/access/certs" {
			t.Errorf("%s -> %s %s", in, v.Issuer, v.CertsURL)
		}
	}
}
