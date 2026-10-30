// Package cfaccess verifies Cloudflare Access application tokens (RS256 JWTs)
// so that a request reaching Pimu through a tunnel provably passed Access.
//
// Docs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
package cfaccess

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	Header = "Cf-Access-Jwt-Assertion"
	Cookie = "CF_Authorization"
	skew   = 60 * time.Second
)

type Claims struct {
	Iss        string   `json:"iss"`
	Aud        audience `json:"aud"`
	Exp        int64    `json:"exp"`
	Nbf        int64    `json:"nbf"`
	Email      string   `json:"email"`
	CommonName string   `json:"common_name"` // service tokens: the client ID
}

// audience accepts "aud" as a string or a list.
type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*a = audience{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

type Verifier struct {
	Issuer   string // https://<team>.cloudflareaccess.com
	CertsURL string
	AUD      string
	Allow    map[string]bool // optional: email or service token client ID

	Client     *http.Client
	Now        func() time.Time
	MinRefresh time.Duration // unknown kid refetches at most this often
	MaxAge     time.Duration // keys are refetched after this

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

// New builds a verifier for team ("myteam", "myteam.cloudflareaccess.com"
// or a URL) and the application's AUD tag.
func New(team, aud string, allow []string) *Verifier {
	host := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(team, "https://"), "http://"), "/")
	if !strings.Contains(host, ".") {
		host += ".cloudflareaccess.com"
	}
	v := &Verifier{
		Issuer: "https://" + host, AUD: aud,
		Client: &http.Client{Timeout: 5 * time.Second}, Now: time.Now,
		MinRefresh: 30 * time.Second, MaxAge: time.Hour,
	}
	v.CertsURL = v.Issuer + "/cdn-cgi/access/certs"
	if len(allow) > 0 {
		v.Allow = map[string]bool{}
		for _, a := range allow {
			if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
				v.Allow[a] = true
			}
		}
	}
	return v
}

// Token returns the request's Access token: the header, else the cookie.
func Token(r *http.Request) string {
	if t := r.Header.Get(Header); t != "" {
		return t
	}
	if c, err := r.Cookie(Cookie); err == nil {
		return c.Value
	}
	return ""
}

var errMissing = errors.New("no Access token")

// Verify checks signature, issuer, audience, time window and the allowlist.
func (v *Verifier) Verify(ctx context.Context, token string) (*Claims, error) {
	if token == "" {
		return nil, errMissing
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodePart(parts[0], &hdr); err != nil {
		return nil, fmt.Errorf("header: %w", err)
	}
	if hdr.Alg != "RS256" {
		return nil, fmt.Errorf("alg %q not allowed", hdr.Alg)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, errors.New("bad signature encoding")
	}
	key, err := v.key(ctx, hdr.Kid)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig); err != nil {
		return nil, errors.New("bad signature")
	}
	var c Claims
	if err := decodePart(parts[1], &c); err != nil {
		return nil, fmt.Errorf("claims: %w", err)
	}
	now := v.Now()
	switch {
	case c.Iss != v.Issuer:
		return nil, fmt.Errorf("issuer %q", c.Iss)
	case !contains(c.Aud, v.AUD):
		return nil, errors.New("wrong audience")
	case c.Exp == 0 || now.After(time.Unix(c.Exp, 0).Add(skew)):
		return nil, errors.New("expired")
	case c.Nbf != 0 && now.Add(skew).Before(time.Unix(c.Nbf, 0)):
		return nil, errors.New("not valid yet")
	}
	if v.Allow != nil && !v.Allow[strings.ToLower(c.Email)] && !v.Allow[strings.ToLower(c.CommonName)] {
		return nil, fmt.Errorf("identity %q not allowed", c.Email+c.CommonName)
	}
	return &c, nil
}

// key returns the public key for kid, fetching the JWKS when it is stale or
// the kid is unknown (at most once per MinRefresh).
func (v *Verifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.Now()
	k, ok := v.keys[kid]
	stale := now.Sub(v.fetched) > v.MaxAge
	if (!ok || stale) && (v.fetched.IsZero() || now.Sub(v.fetched) >= v.MinRefresh) {
		keys, err := v.fetch(ctx)
		v.fetched = now // also after a failure, so a dead endpoint is not hammered
		if err != nil && v.keys == nil {
			return nil, fmt.Errorf("fetch keys: %w", err)
		}
		if err == nil {
			v.keys = keys
		}
		k, ok = v.keys[kid]
	}
	if !ok {
		return nil, fmt.Errorf("unknown key id %q", kid)
	}
	return k, nil
}

func (v *Verifier) fetch(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.CertsURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := v.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("certs: HTTP %d", resp.StatusCode)
	}
	var set struct {
		Keys []struct {
			Kid, Kty, N, E string
		} `json:"keys"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&set); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil || len(e) > 4 {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	if len(keys) == 0 {
		return nil, errors.New("no RSA keys in certs")
	}
	return keys, nil
}

func decodePart(s string, out any) error {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
