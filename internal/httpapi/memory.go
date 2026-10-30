package httpapi

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
)

const memoryMax = 1 << 20

// Memory is pi's global AGENTS.md; mtime (unix µs, 0 = file absent) is the
// optimistic-concurrency token for PUT. Microseconds, not ns: the browser parses
// JSON numbers as float64 and ns timestamps (>2^53) would never round-trip.
func (s *Server) memoryPath() string { return filepath.Join(s.cfg.AgentDir, "AGENTS.md") }

func mtimeOf(path string) (int64, error) {
	st, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return st.ModTime().UnixMicro(), nil
}

func (s *Server) handleMemoryGet(w http.ResponseWriter, r *http.Request) {
	p := s.memoryPath()
	b, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	mt, err := mtimeOf(p)
	if err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"path": p, "content": string(b), "mtime": mt})
}

func (s *Server) handleMemoryPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
		Mtime   int64  `json:"mtime"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Content) > memoryMax {
		writeErr(w, 413, "too_large", "AGENTS.md 超过 1 MB")
		return
	}
	p := s.memoryPath()
	mt, err := mtimeOf(p)
	if err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	if mt != body.Mtime {
		writeJSON(w, 409, map[string]any{"error": "conflict", "message": "文件已被其他程序修改，请重新加载后再保存", "mtime": mt})
		return
	}
	if err := writeAtomic(p, []byte(body.Content), 0o644); err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return
	}
	mt, _ = mtimeOf(p)
	writeJSON(w, 200, map[string]any{"path": p, "mtime": mt})
}

// writeAtomic writes via temp file + rename so pi never reads a half-written
// file. An existing file keeps its permissions.
func writeAtomic(p string, data []byte, mode os.FileMode) error {
	if st, err := os.Stat(p); err == nil {
		mode = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".*")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), mode)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), p)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}
