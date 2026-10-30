package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

// Settings is a thin window onto pi's own files (settings.json, models.json,
// mcp.json, extensions/). Pimu never keeps a copy; writes are small
// read-modify-write edits guarded by the file's mtime, like Memory.

var builtinExtensions = []string{"mcp", "llama.cpp", "codemode", "tool-search"}

var (
	secretKey  = regexp.MustCompile(`(?i)(key|token|secret|passw|auth|cookie|credential)`)
	secretText = regexp.MustCompile(`(sk-[A-Za-z0-9_\-]{6,}|ghp_\w+|xox[a-z]-\S+|(?i:bearer)\s+\S+)`)
	secretFlag = regexp.MustCompile(`(?i)(--?\S*(?:key|token|secret|passw)\S*)([ =])(\S+)`)
)

const masked = "••••••"

// mask hides credentials: values under secret-looking keys, everything under
// env/headers, and token-shaped substrings anywhere else.
func mask(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			switch {
			case k == "env" || k == "headers":
				if m, ok := x.(map[string]any); ok {
					h := map[string]any{}
					for hk := range m {
						h[hk] = masked
					}
					out[k] = h
					continue
				}
				out[k] = masked
			case secretKey.MatchString(k) && !strings.HasPrefix(k, "max") && !notScalarString(x):
				if s, ok := x.(string); ok && strings.HasPrefix(s, "!") {
					out[k] = "!（命令已隐藏）"
				} else {
					out[k] = masked
				}
			default:
				out[k] = mask(x)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = mask(x)
		}
		return out
	case string:
		return maskText(t)
	}
	return v
}

func maskText(s string) string {
	s = secretFlag.ReplaceAllString(s, "$1$2"+masked)
	return secretText.ReplaceAllString(s, masked)
}

func notScalarString(v any) bool {
	switch v.(type) {
	case bool, float64, map[string]any, []any:
		return true
	}
	return false
}

func readJSONFile(p string) (map[string]any, int64, error) {
	mt, err := mtimeOf(p)
	if err != nil {
		return nil, 0, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]any{}, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	m := map[string]any{}
	if len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, 0, err
		}
	}
	return m, mt, nil
}

// editJSONFile applies fn to the parsed file and writes it back atomically,
// failing with 409 when mtime no longer matches what the client saw.
func (s *Server) editJSONFile(w http.ResponseWriter, p string, mtime int64, fn func(map[string]any) error) bool {
	m, mt, err := readJSONFile(p)
	if err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return false
	}
	if mt != mtime {
		writeJSON(w, 409, map[string]any{"error": "conflict", "message": "配置文件已被其他程序修改，请刷新后重试", "mtime": mt})
		return false
	}
	if err := fn(m); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return false
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := writeAtomic(p, append(b, '\n'), 0o600); err != nil {
		writeErr(w, 500, "io_error", err.Error())
		return false
	}
	s.hub.ForgetModels()
	return true
}

func (s *Server) settingsPath() string { return filepath.Join(s.cfg.AgentDir, "settings.json") }
func (s *Server) mcpPath() string      { return filepath.Join(s.cfg.AgentDir, "mcp.json") }

func strList(v any) []string {
	var out []string
	if a, ok := v.([]any); ok {
		for _, x := range a {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	set, setMt, err := readJSONFile(s.settingsPath())
	if err != nil {
		writeErr(w, 500, "io_error", "settings.json: "+err.Error())
		return
	}
	mcp, mcpMt, err := readJSONFile(s.mcpPath())
	if err != nil {
		writeErr(w, 500, "io_error", "mcp.json: "+err.Error())
		return
	}
	models, _, err := readJSONFile(filepath.Join(s.cfg.AgentDir, "models.json"))
	if err != nil {
		models = map[string]any{"error": err.Error()}
	}

	exts := strList(set["extensions"])
	type ext struct {
		Name    string `json:"name"`
		Path    string `json:"path,omitempty"`
		Builtin bool   `json:"builtin"`
		Enabled bool   `json:"enabled"`
	}
	var extOut []ext
	for _, b := range builtinExtensions {
		extOut = append(extOut, ext{Name: b, Builtin: true, Enabled: !slices.Contains(exts, "-builtin:"+b)})
	}
	if ents, err := os.ReadDir(filepath.Join(s.cfg.AgentDir, "extensions")); err == nil {
		for _, e := range ents {
			n := e.Name()
			if strings.HasPrefix(n, ".") || (!e.IsDir() && !strings.HasSuffix(n, ".ts") && !strings.HasSuffix(n, ".js")) {
				continue
			}
			extOut = append(extOut, ext{Name: n, Path: filepath.Join(s.cfg.AgentDir, "extensions", n), Enabled: true})
		}
	}
	for _, e := range exts { // explicit paths listed in settings
		if !strings.HasPrefix(e, "-builtin:") && !strings.HasPrefix(e, "+builtin:") {
			extOut = append(extOut, ext{Name: maskText(e), Path: maskText(e), Enabled: !strings.HasPrefix(e, "-") && !strings.HasPrefix(e, "!")})
		}
	}

	tg := map[string]any{"configured": s.cfg.TGToken != "" && s.cfg.TGChatID != ""}
	if c := s.cfg.TGChatID; len(c) > 4 {
		tg["chat"] = "…" + c[len(c)-4:]
	}
	writeJSON(w, 200, map[string]any{
		"agentDir":      s.cfg.AgentDir,
		"settings":      mask(set),
		"settingsMtime": setMt,
		"models":        mask(models),
		"mcp":           mask(mcp),
		"mcpMtime":      mcpMt,
		"extensions":    extOut,
		"packages":      mask(set["packages"]),
		"telegram":      tg,
		"version":       s.version,
		"piVersion":     s.piVersion,
		"publicUrl":     s.cfg.PublicURL,
	})
}

// PATCH /api/settings/model {provider, modelId, thinking?, mtime}
func (s *Server) handleSettingsModel(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Provider, ModelID, Thinking string
		Mtime                       int64
	}
	if !readJSON(w, r, &b) {
		return
	}
	if b.Provider == "" || b.ModelID == "" {
		writeErr(w, 400, "bad_request", "provider/modelId 必填")
		return
	}
	levels := []string{"", "off", "minimal", "low", "medium", "high", "xhigh", "max"}
	if !slices.Contains(levels, b.Thinking) {
		writeErr(w, 400, "bad_request", "未知思考强度")
		return
	}
	if s.editJSONFile(w, s.settingsPath(), b.Mtime, func(m map[string]any) error {
		m["defaultProvider"], m["defaultModel"] = b.Provider, b.ModelID
		if b.Thinking != "" {
			lv, _ := m["modelThinkingLevels"].(map[string]any)
			if lv == nil {
				lv = map[string]any{}
			}
			lv[b.Provider+"/"+b.ModelID] = b.Thinking
			m["modelThinkingLevels"] = lv
		}
		return nil
	}) {
		s.handleSettingsGet(w, r)
	}
}

// PATCH /api/settings/extension {name, enabled, mtime} — builtins only; pi
// toggles them with a "-builtin:<name>" entry in settings.extensions.
func (s *Server) handleSettingsExtension(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name    string
		Enabled bool
		Mtime   int64
	}
	if !readJSON(w, r, &b) {
		return
	}
	if !slices.Contains(builtinExtensions, b.Name) {
		writeErr(w, 400, "bad_request", "只能开关内置扩展；其他扩展请用 pi config")
		return
	}
	if s.editJSONFile(w, s.settingsPath(), b.Mtime, func(m map[string]any) error {
		off := "-builtin:" + b.Name
		var out []any
		for _, e := range strList(m["extensions"]) {
			if e != off && e != "+builtin:"+b.Name {
				out = append(out, e)
			}
		}
		if !b.Enabled {
			out = append(out, off)
		}
		if len(out) == 0 {
			delete(m, "extensions")
		} else {
			m["extensions"] = out
		}
		return nil
	}) {
		s.handleSettingsGet(w, r)
	}
}

// PATCH /api/settings/mcp/{name} {enabled, mtime} — flips the server's
// documented "enabled" field in the user-level mcp.json.
func (s *Server) handleSettingsMCP(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var b struct {
		Enabled bool
		Mtime   int64
	}
	if !readJSON(w, r, &b) {
		return
	}
	if s.editJSONFile(w, s.mcpPath(), b.Mtime, func(m map[string]any) error {
		servers, _ := m["mcpServers"].(map[string]any)
		srv, ok := servers[name].(map[string]any)
		if !ok {
			return errors.New("没有这个 MCP 服务器")
		}
		if b.Enabled {
			delete(srv, "enabled")
		} else {
			srv["enabled"] = false
		}
		return nil
	}) {
		s.handleSettingsGet(w, r)
	}
}

// GET /api/settings/mcp/status runs `pi mcp list --json`, which connects to
// every enabled server (a few seconds).
func (s *Server) handleMCPStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	home, _ := os.UserHomeDir()
	cmd := exec.CommandContext(ctx, s.cfg.PiBin, "mcp", "list", "--json")
	cmd.Dir = home
	out, _ := cmd.Output() // exits 1 when a server fails; JSON is still printed
	var v any
	if err := json.Unmarshal(out, &v); err != nil {
		writeErr(w, 502, "pi_error", "pi mcp list 没有返回 JSON")
		return
	}
	writeJSON(w, 200, mask(v))
}

type piCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
	SourceInfo  struct {
		Path   string `json:"path"`
		Source string `json:"source"`
		Scope  string `json:"scope"`
		Origin string `json:"origin"`
	} `json:"sourceInfo"`
}

func (s *Server) piCommands(ctx context.Context) ([]piCommand, error) {
	raw, err := s.hub.Query(ctx, "get_commands")
	if err != nil {
		return nil, err
	}
	var d struct {
		Commands []piCommand `json:"commands"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	sort.SliceStable(d.Commands, func(i, j int) bool { return d.Commands[i].Source < d.Commands[j].Source })
	return d.Commands, nil
}

// GET /api/settings/commands: skills, prompt templates and extension commands
// exactly as pi discovered them.
func (s *Server) handleSettingsCommands(w http.ResponseWriter, r *http.Request) {
	cmds, err := s.piCommands(r.Context())
	if err != nil {
		writeErr(w, 502, "pi_error", err.Error())
		return
	}
	if cmds == nil {
		cmds = []piCommand{}
	}
	writeJSON(w, 200, map[string]any{"commands": cmds})
}

// GET /api/settings/skill?name=skill:x returns the file of a discovered
// skill/prompt only — never an arbitrary path.
func (s *Server) handleSettingsSkill(w http.ResponseWriter, r *http.Request) {
	cmds, err := s.piCommands(r.Context())
	if err != nil {
		writeErr(w, 502, "pi_error", err.Error())
		return
	}
	name := r.URL.Query().Get("name")
	for _, c := range cmds {
		if c.Name != name || c.Source == "extension" {
			continue
		}
		p := c.SourceInfo.Path
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			p = filepath.Join(p, "SKILL.md")
		}
		b, err := os.ReadFile(p)
		if err != nil {
			writeErr(w, 500, "io_error", err.Error())
			return
		}
		if len(b) > memoryMax {
			b = b[:memoryMax]
		}
		writeJSON(w, 200, map[string]any{"path": p, "content": maskText(string(b))})
		return
	}
	writeErr(w, 404, "not_found", "没有这个 skill")
}
