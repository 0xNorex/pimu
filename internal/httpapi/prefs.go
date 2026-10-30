package httpapi

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
)

// Appearance preferences are the web app's business; Pimu only keeps the last
// copy so another device picks it up. One small JSON blob, last write wins.
const prefsMax = 8 << 10

func (s *Server) prefsPath() string { return filepath.Join(s.cfg.DataDir, "prefs.json") }

func (s *Server) handlePrefsGet(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(s.prefsPath())
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, 200, map[string]any{"prefs": nil, "at": 0})
		return
	}
	if err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	writeRaw(w, b)
}

func (s *Server) handlePrefsPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, prefsMax)
	var body struct {
		Prefs map[string]any `json:"prefs"`
		At    int64          `json:"at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Prefs == nil {
		writeErr(w, 400, "bad_json", "需要 {prefs, at}")
		return
	}
	b, _ := json.Marshal(body)
	if err := writeAtomic(s.prefsPath(), b, 0o600); err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	writeRaw(w, b)
}
