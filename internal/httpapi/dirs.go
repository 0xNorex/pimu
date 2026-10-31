package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// cwdErr is the one message for a working directory Pimu may not use.
func (s *Server) cwdErr(dir string) string {
	if strings.TrimSpace(dir) == "" {
		dir = "（默认目录）"
	}
	return "目录 " + dir + " 不存在或不在允许范围内（" + strings.Join(s.cfg.Workdirs, ", ") + "）。可在 PIMU_WORKDIRS 里加上它后重启 Pimu。"
}

type dirsOut struct {
	Path   string   `json:"path,omitempty"`   // the listed directory
	Parent string   `json:"parent,omitempty"` // "" at a root
	Dirs   []string `json:"dirs"`             // child directory names
	Roots  []string `json:"roots"`
	Recent []string `json:"recent"` // allowed cwds of recent sessions
	Home   string   `json:"home"`
}

// handleDirs: GET /api/dirs[?path=] lists subdirectories of an allowed
// directory (hidden ones skipped), plus the roots and recent session cwds.
// Paths are resolved (symlinks too) and must stay inside PIMU_WORKDIRS.
func (s *Server) handleDirs(w http.ResponseWriter, r *http.Request) {
	home, _ := os.UserHomeDir()
	out := dirsOut{Dirs: []string{}, Roots: s.cfg.Workdirs, Recent: s.recentCwds(8), Home: home}
	if p := r.URL.Query().Get("path"); p != "" {
		dir, ok := s.cfg.AllowedDir(p)
		if !ok {
			writeErr(w, 400, "bad_cwd", s.cwdErr(p))
			return
		}
		out.Path = dir
		if parent := filepath.Dir(dir); parent != dir {
			if pd, ok := s.cfg.AllowedDir(parent); ok {
				out.Parent = pd
			}
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			writeErr(w, 400, "read_error", err.Error())
			return
		}
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			if e.IsDir() || (e.Type()&os.ModeSymlink != 0 && s.allowedLink(filepath.Join(dir, e.Name()))) {
				out.Dirs = append(out.Dirs, e.Name())
			}
			if len(out.Dirs) >= 500 {
				break
			}
		}
		sort.Strings(out.Dirs)
	}
	writeJSON(w, 200, out)
}

// allowedLink: a symlinked directory is listed only when its target is
// itself allowed; a link out of PIMU_WORKDIRS would only fail when clicked.
func (s *Server) allowedLink(p string) bool {
	_, ok := s.cfg.AllowedDir(p)
	return ok
}

// handleMkdir: POST /api/dirs {path, name} creates one subdirectory.
func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	parent, ok := s.cfg.AllowedDir(body.Path)
	if !ok {
		writeErr(w, 400, "bad_cwd", s.cwdErr(body.Path))
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") || len(name) > 100 {
		writeErr(w, 400, "bad_name", "文件夹名不能为空、不能以 . 开头，也不能含 /")
		return
	}
	dir := filepath.Join(parent, name)
	if err := os.Mkdir(dir, 0o755); err != nil {
		writeErr(w, 400, "mkdir_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"path": dir})
}

// recentCwds: distinct allowed cwds of the newest sessions.
func (s *Server) recentCwds(n int) []string {
	list := s.hub.Idx.List()
	sort.Slice(list, func(i, j int) bool { return list[i].UpdatedAt.After(list[j].UpdatedAt) })
	out, seen := []string{}, map[string]bool{}
	for _, info := range list {
		if len(out) >= n {
			break
		}
		if info.Cwd == "" || seen[info.Cwd] || strings.HasPrefix(info.ID, "pimu-") {
			continue
		}
		seen[info.Cwd] = true
		if d, ok := s.cfg.AllowedDir(info.Cwd); ok {
			out = append(out, d)
		}
	}
	return out
}
