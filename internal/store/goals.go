package store

import (
	"database/sql"
	"errors"
	"time"
)

// goalsSchema is migration 3 (docs/AUTONOMY.md "数据"). It only adds tables
// and a nullable column, so existing bots/tasks rows are untouched.
const goalsSchema = `
CREATE TABLE goals (
  id           INTEGER PRIMARY KEY,
  bot_id       TEXT    NOT NULL REFERENCES bots(session_id) ON DELETE CASCADE,
  slug         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  level        INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  every_sec    INTEGER NOT NULL DEFAULT 3600,
  active_hours TEXT    NOT NULL DEFAULT '',
  run_sec      INTEGER NOT NULL DEFAULT 600,
  run_tokens   INTEGER NOT NULL DEFAULT 200000,
  day_tokens   INTEGER NOT NULL DEFAULT 1000000,
  hook_secret  TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_at      TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (bot_id, slug)
);
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL CHECK (source IN ('hook','probe','task','user')),
  dedup_key  TEXT    NOT NULL,
  payload    TEXT    NOT NULL DEFAULT '',
  beat_id    INTEGER,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (goal_id, dedup_key)
);
CREATE TABLE inbox (
  id         INTEGER PRIMARY KEY,
  goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('notify','ask','approval')),
  dedup_key  TEXT    NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT '',
  tool       TEXT    NOT NULL DEFAULT '',
  args_hash  TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','approved','denied','used','expired')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  UNIQUE (goal_id, dedup_key)
);
CREATE TABLE beats (
  id          INTEGER PRIMARY KEY,
  goal_id     INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','budget','error')),
  tokens      INTEGER NOT NULL DEFAULT 0,
  outcome     TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  started_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX beats_goal_started ON beats(goal_id, started_at DESC);
ALTER TABLE tasks ADD COLUMN goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL;
`

type Goal struct {
	ID          int64   `json:"id"`
	BotID       string  `json:"botId"`
	Slug        string  `json:"slug"`
	Title       string  `json:"title"`
	Level       int     `json:"level"`
	EverySec    int     `json:"everySec"`
	ActiveHours string  `json:"activeHours"` // "8-23" local time, empty = always
	RunSec      int     `json:"runSec"`
	RunTokens   int     `json:"runTokens"`
	DayTokens   int     `json:"dayTokens"`
	HookSecret  string  `json:"-"`
	Enabled     bool    `json:"enabled"`
	NextAt      *string `json:"nextAt"`
	CreatedAt   string  `json:"createdAt"`
}

const goalCols = `id, bot_id, slug, title, level, every_sec, active_hours, run_sec, run_tokens, day_tokens, hook_secret, enabled, next_at, created_at`

func scanGoal(r scanner) (Goal, error) {
	var g Goal
	err := r.Scan(&g.ID, &g.BotID, &g.Slug, &g.Title, &g.Level, &g.EverySec, &g.ActiveHours, &g.RunSec, &g.RunTokens, &g.DayTokens, &g.HookSecret, &g.Enabled, &g.NextAt, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return g, err
}

// Goals lists the goals of one bot, or all goals when botID is empty.
func (s *Store) Goals(botID string) ([]Goal, error) {
	rows, err := s.db.Query(`SELECT `+goalCols+` FROM goals WHERE ? = '' OR bot_id = ? ORDER BY id`, botID, botID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Goal{}
	for rows.Next() {
		g, err := scanGoal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) Goal(id int64) (Goal, error) {
	return scanGoal(s.db.QueryRow(`SELECT `+goalCols+` FROM goals WHERE id = ?`, id))
}

// CreateGoal inserts g; the slug is g<id>, set after the insert.
func (s *Store) CreateGoal(g Goal) (Goal, error) {
	res, err := s.db.Exec(`INSERT INTO goals (bot_id, slug, title, level, every_sec, active_hours, run_sec, run_tokens, day_tokens, hook_secret, enabled, next_at)
		VALUES (?, hex(randomblob(8)), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		g.BotID, g.Title, g.Level, g.EverySec, g.ActiveHours, g.RunSec, g.RunTokens, g.DayTokens, g.HookSecret, g.Enabled, g.NextAt)
	if err != nil {
		return Goal{}, err
	}
	id, _ := res.LastInsertId()
	if _, err := s.db.Exec(`UPDATE goals SET slug = 'g' || id WHERE id = ?`, id); err != nil {
		return Goal{}, err
	}
	return s.Goal(id)
}

func (s *Store) UpdateGoal(g Goal) (Goal, error) {
	res, err := s.db.Exec(`UPDATE goals SET title=?, level=?, every_sec=?, active_hours=?, run_sec=?, run_tokens=?, day_tokens=?, enabled=?, next_at=? WHERE id=?`,
		g.Title, g.Level, g.EverySec, g.ActiveHours, g.RunSec, g.RunTokens, g.DayTokens, g.Enabled, g.NextAt, g.ID)
	if err != nil {
		return Goal{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Goal{}, ErrNotFound
	}
	return s.Goal(g.ID)
}

func (s *Store) DeleteGoal(id int64) error {
	_, err := s.db.Exec(`DELETE FROM goals WHERE id = ?`, id)
	return err
}

func (s *Store) SetNextAt(id int64, t time.Time) error {
	_, err := s.db.Exec(`UPDATE goals SET next_at = ? WHERE id = ?`, t.UTC().Format("2006-01-02T15:04:05.000Z"), id)
	return err
}

func (s *Store) DisableGoal(id int64) error {
	_, err := s.db.Exec(`UPDATE goals SET enabled = 0 WHERE id = ?`, id)
	return err
}

// ---- events

type Event struct {
	ID        int64  `json:"id"`
	GoalID    int64  `json:"goalId"`
	Source    string `json:"source"`
	DedupKey  string `json:"dedupKey"`
	Payload   string `json:"payload"`
	BeatID    *int64 `json:"beatId"`
	CreatedAt string `json:"createdAt"`
}

// AddEvent inserts an event; a repeated dedup key is ignored (added=false).
func (s *Store) AddEvent(goalID int64, source, key, payload string) (added bool, err error) {
	res, err := s.db.Exec(`INSERT OR IGNORE INTO events (goal_id, source, dedup_key, payload) VALUES (?, ?, ?, ?)`, goalID, source, key, payload)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// PendingEvents are the goal's events no beat has consumed yet, oldest first.
func (s *Store) PendingEvents(goalID int64) ([]Event, error) {
	rows, err := s.db.Query(`SELECT id, goal_id, source, dedup_key, payload, beat_id, created_at FROM events WHERE goal_id = ? AND beat_id IS NULL ORDER BY id LIMIT 50`, goalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.GoalID, &e.Source, &e.DedupKey, &e.Payload, &e.BeatID, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) ConsumeEvents(beatID int64, ids []int64) error {
	for _, id := range ids {
		if _, err := s.db.Exec(`UPDATE events SET beat_id = ? WHERE id = ? AND beat_id IS NULL`, beatID, id); err != nil {
			return err
		}
	}
	return nil
}

// ---- inbox

type Item struct {
	ID        int64   `json:"id"`
	GoalID    int64   `json:"goalId"`
	Kind      string  `json:"kind"`
	DedupKey  string  `json:"dedupKey"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	Tool      string  `json:"tool"`
	ArgsHash  string  `json:"-"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"createdAt"`
	DecidedAt *string `json:"decidedAt"`
	// joined for display
	GoalTitle string `json:"goalTitle"`
	BotID     string `json:"botId"`
	BotName   string `json:"botName"`
}

const itemCols = `i.id, i.goal_id, i.kind, i.dedup_key, i.title, i.body, i.tool, i.args_hash, i.status, i.created_at, i.decided_at, g.title, g.bot_id, b.name`
const itemFrom = ` FROM inbox i JOIN goals g ON g.id = i.goal_id JOIN bots b ON b.session_id = g.bot_id`

func scanItem(r scanner) (Item, error) {
	var it Item
	err := r.Scan(&it.ID, &it.GoalID, &it.Kind, &it.DedupKey, &it.Title, &it.Body, &it.Tool, &it.ArgsHash, &it.Status, &it.CreatedAt, &it.DecidedAt, &it.GoalTitle, &it.BotID, &it.BotName)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return it, err
}

// AddItem inserts an inbox row unless (goal, dedup key) exists; it returns the
// row either way and whether it is new.
func (s *Store) AddItem(it Item) (Item, bool, error) {
	res, err := s.db.Exec(`INSERT OR IGNORE INTO inbox (goal_id, kind, dedup_key, title, body, tool, args_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		it.GoalID, it.Kind, it.DedupKey, it.Title, it.Body, it.Tool, it.ArgsHash)
	if err != nil {
		return Item{}, false, err
	}
	n, _ := res.RowsAffected()
	out, err := scanItem(s.db.QueryRow(`SELECT `+itemCols+itemFrom+` WHERE i.goal_id = ? AND i.dedup_key = ?`, it.GoalID, it.DedupKey))
	return out, n > 0, err
}

func (s *Store) Item(id int64) (Item, error) {
	return scanItem(s.db.QueryRow(`SELECT `+itemCols+itemFrom+` WHERE i.id = ?`, id))
}

// Items lists inbox rows, newest first; open=true keeps only undecided ones.
func (s *Store) Items(botID string, open bool, limit int) ([]Item, error) {
	q := `SELECT ` + itemCols + itemFrom + ` WHERE (? = '' OR g.bot_id = ?)`
	if open {
		q += ` AND i.status IN ('new','read')`
	}
	rows, err := s.db.Query(q+` ORDER BY i.id DESC LIMIT ?`, botID, botID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (s *Store) Unread() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM inbox WHERE status = 'new'`).Scan(&n)
	return n, err
}

// SetItemStatus moves an item to status if it is currently in one of from.
func (s *Store) SetItemStatus(id int64, status string, from ...string) (bool, error) {
	q := `UPDATE inbox SET status = ?, decided_at = CASE WHEN ? IN ('approved','denied','used') THEN ? ELSE decided_at END WHERE id = ?`
	args := []any{status, status, now(), id}
	if len(from) > 0 {
		q += ` AND status IN (?` + repeat(",?", len(from)-1) + `)`
		for _, f := range from {
			args = append(args, f)
		}
	}
	res, err := s.db.Exec(q, args...)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

// ---- beats

type Beat struct {
	ID         int64   `json:"id"`
	GoalID     int64   `json:"goalId"`
	SessionID  string  `json:"sessionId"`
	Status     string  `json:"status"`
	Tokens     int     `json:"tokens"`
	Outcome    string  `json:"outcome"`
	Summary    string  `json:"summary"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
}

func (s *Store) StartBeat(goalID int64) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO beats (goal_id) VALUES (?)`, goalID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) SetBeatSession(id int64, sid string) error {
	_, err := s.db.Exec(`UPDATE beats SET session_id = ? WHERE id = ?`, sid, id)
	return err
}

func (s *Store) DeleteBeat(id int64) error {
	_, err := s.db.Exec(`DELETE FROM beats WHERE id = ?`, id)
	return err
}

func (s *Store) FinishBeat(id int64, status string, tokens int, outcome, summary string) error {
	_, err := s.db.Exec(`UPDATE beats SET status=?, tokens=?, outcome=?, summary=?, finished_at=? WHERE id=?`, status, tokens, outcome, summary, now(), id)
	return err
}

// InterruptBeats marks beats left running by a restart as errors.
func (s *Store) InterruptBeats() error {
	_, err := s.db.Exec(`UPDATE beats SET status='error', summary='interrupted: pimu restarted', finished_at=? WHERE status='running'`, now())
	return err
}

func (s *Store) Beats(goalID int64, limit int) ([]Beat, error) {
	rows, err := s.db.Query(`SELECT id, goal_id, session_id, status, tokens, outcome, summary, started_at, finished_at FROM beats WHERE goal_id = ? ORDER BY id DESC LIMIT ?`, goalID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Beat{}
	for rows.Next() {
		var b Beat
		if err := rows.Scan(&b.ID, &b.GoalID, &b.SessionID, &b.Status, &b.Tokens, &b.Outcome, &b.Summary, &b.StartedAt, &b.FinishedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// BeatStats returns tokens used since `since`, beats started since `hourAgo`,
// and whether a beat is running.
func (s *Store) BeatStats(goalID int64, since, hourAgo time.Time) (tokens, lastHour int, running bool, err error) {
	f := "2006-01-02T15:04:05.000Z"
	var r int
	err = s.db.QueryRow(`SELECT
		coalesce(sum(CASE WHEN started_at >= ? THEN tokens END), 0),
		count(CASE WHEN started_at >= ? THEN 1 END),
		count(CASE WHEN status = 'running' THEN 1 END)
		FROM beats WHERE goal_id = ?`, since.UTC().Format(f), hourAgo.UTC().Format(f), goalID).Scan(&tokens, &lastHour, &r)
	return tokens, lastHour, r > 0, err
}

// ---- goal-linked one-off tasks

// GoalTask creates a one-off task (no schedule, new session, never notify)
// whose result flows back to the goal as an event.
func (s *Store) GoalTask(goalID int64, name, prompt, cwd string, timeoutSec int) (Task, error) {
	res, err := s.db.Exec(`INSERT INTO tasks (name, prompt, cwd, session_mode, notify, max_retries, timeout_sec, enabled, goal_id)
		VALUES (?, ?, ?, 'new', 'never', 0, ?, 1, ?)`, name, prompt, cwd, timeoutSec, goalID)
	if err != nil {
		return Task{}, err
	}
	id, _ := res.LastInsertId()
	return s.Task(id)
}

// TaskGoal returns the goal a task belongs to (0 if none).
func (s *Store) TaskGoal(taskID int64) int64 {
	var g sql.NullInt64
	_ = s.db.QueryRow(`SELECT goal_id FROM tasks WHERE id = ?`, taskID).Scan(&g)
	return g.Int64
}
