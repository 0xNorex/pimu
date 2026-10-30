package httpapi

import (
	"compress/gzip"
	"io"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestStaticGzipsAssets(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":        {Data: []byte("<html>")},
		"assets/app-1.js":   {Data: []byte("console.log('hi')")},
		"assets/font.woff2": {Data: []byte("font")},
	}
	h := staticHandler(fsys)
	get := func(p string, gz bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", p, nil)
		if gz {
			r.Header.Set("Accept-Encoding", "gzip, br")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	w := get("/assets/app-1.js", true)
	if w.Header().Get("Content-Encoding") != "gzip" || w.Header().Get("Cache-Control") == "" {
		t.Fatalf("headers %v", w.Header())
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := io.ReadAll(zr); string(b) != "console.log('hi')" {
		t.Fatalf("body %q", b)
	}
	if w := get("/assets/app-1.js", false); w.Header().Get("Content-Encoding") != "" || w.Body.String() != "console.log('hi')" {
		t.Fatal("plain client got gzip")
	}
	if w := get("/assets/font.woff2", true); w.Header().Get("Content-Encoding") != "" {
		t.Fatal("font gzipped")
	}
}
