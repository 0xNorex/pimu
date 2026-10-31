// Package store is Pimu's SQLite database: tasks, runs, bots (the display
// metadata pi cannot hold for a session) and the autonomy tables (goals,
// events, inbox, beats; see docs/AUTONOMY.md).
// Sessions, messages, activity and memory stay in pi's own files.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

// migrations[i] moves the schema from user_version i to i+1.
var migrations = []string{`
CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  prompt       TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  schedule     TEXT,
  model        TEXT,
  session_mode TEXT    NOT NULL DEFAULT 'new' CHECK (session_mode IN ('new','reuse')),
  session_id   TEXT,
  notify       TEXT    NOT NULL DEFAULT 'failure' CHECK (notify IN ('always','failure','never')),
  max_retries  INTEGER NOT NULL DEFAULT 1,
  timeout_sec  INTEGER NOT NULL DEFAULT 1800,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger      TEXT    NOT NULL CHECK (trigger IN ('cron','manual','retry')),
  attempt      INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL CHECK (status IN ('queued','running','succeeded','failed','aborted')),
  session_id   TEXT,
  summary      TEXT,
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX runs_task_created ON runs(task_id, created_at DESC);
CREATE INDEX runs_status ON runs(status) WHERE status IN ('queued','running');
`, `
CREATE TABLE bots (
  session_id   TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  emoji        TEXT    NOT NULL DEFAULT '🤖',
  description  TEXT    NOT NULL DEFAULT '',
  persona      TEXT    NOT NULL DEFAULT '',
  cwd          TEXT    NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`, goalsSchema, jobsSchema, approvalsSchema, botModeSchema, inboxIndexSchema, botPausedSchema}

type Store struct{ db *sql.DB }

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "pimu.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer, simplest correct choice
	for _, p := range []string{"PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=5000", "PRAGMA foreign_keys=ON"} {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", p, err)
		}
	}
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		db.Close()
		return nil, err
	}
	for ; v < len(migrations); v++ {
		tx, err := db.Begin()
		if err != nil {
			db.Close()
			return nil, err
		}
		if _, err := tx.Exec(migrations[v]); err != nil {
			tx.Rollback()
			db.Close()
			return nil, fmt.Errorf("migration %d: %w", v+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", v+1)); err != nil {
			tx.Rollback()
			db.Close()
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Clock is the store's notion of now; tests replace it.
var Clock = time.Now

func now() string           { return ts(Clock()) }
func ts(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

type Task struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Prompt      string  `json:"prompt"`
	Cwd         string  `json:"cwd"`
	Schedule    *string `json:"schedule"`
	Model       *string `json:"model"`
	SessionMode string  `json:"sessionMode"`
	SessionID   *string `json:"sessionId"`
	Notify      string  `json:"notify"`
	MaxRetries  int     `json:"maxRetries"`
	TimeoutSec  int     `json:"timeoutSec"`
	Enabled     bool    `json:"enabled"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

const taskCols = `id, name, prompt, cwd, schedule, model, session_mode, session_id, notify, max_retries, timeout_sec, enabled, created_at, updated_at`

type scanner interface{ Scan(...any) error }

func scanTask(r scanner) (Task, error) {
	var t Task
	err := r.Scan(&t.ID, &t.Name, &t.Prompt, &t.Cwd, &t.Schedule, &t.Model, &t.SessionMode, &t.SessionID, &t.Notify, &t.MaxRetries, &t.TimeoutSec, &t.Enabled, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return t, err
}

func (s *Store) Tasks() ([]Task, error) {
	rows, err := s.db.Query(`SELECT ` + taskCols + ` FROM tasks ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) Task(id int64) (Task, error) {
	return scanTask(s.db.QueryRow(`SELECT `+taskCols+` FROM tasks WHERE id = ?`, id))
}

func (s *Store) CreateTask(t Task) (Task, error) {
	res, err := s.db.Exec(`INSERT INTO tasks (name, prompt, cwd, schedule, model, session_mode, session_id, notify, max_retries, timeout_sec, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Name, t.Prompt, t.Cwd, t.Schedule, t.Model, t.SessionMode, t.SessionID, t.Notify, t.MaxRetries, t.TimeoutSec, t.Enabled)
	if err != nil {
		return Task{}, err
	}
	id, _ := res.LastInsertId()
	return s.Task(id)
}

func (s *Store) UpdateTask(t Task) (Task, error) {
	res, err := s.db.Exec(`UPDATE tasks SET name=?, prompt=?, cwd=?, schedule=?, model=?, session_mode=?, session_id=?, notify=?, max_retries=?, timeout_sec=?, enabled=?, updated_at=? WHERE id=?`,
		t.Name, t.Prompt, t.Cwd, t.Schedule, t.Model, t.SessionMode, t.SessionID, t.Notify, t.MaxRetries, t.TimeoutSec, t.Enabled, now(), t.ID)
	if err != nil {
		return Task{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Task{}, ErrNotFound
	}
	return s.Task(t.ID)
}

func (s *Store) DeleteTask(id int64) error {
	res, err := s.db.Exec(`DELETE FROM tasks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

type Run struct {
	ID         int64   `json:"id"`
	TaskID     int64   `json:"taskId"`
	TaskName   string  `json:"taskName"`
	Trigger    string  `json:"trigger"`
	Attempt    int     `json:"attempt"`
	Status     string  `json:"status"`
	SessionID  *string `json:"sessionId"`
	Summary    *string `json:"summary"`
	Error      *string `json:"error"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	CreatedAt  string  `json:"createdAt"`
}

const runCols = `r.id, r.task_id, t.name, r.trigger, r.attempt, r.status, r.session_id, r.summary, r.error, r.started_at, r.finished_at, r.created_at`

func scanRun(r scanner) (Run, error) {
	var x Run
	err := r.Scan(&x.ID, &x.TaskID, &x.TaskName, &x.Trigger, &x.Attempt, &x.Status, &x.SessionID, &x.Summary, &x.Error, &x.StartedAt, &x.FinishedAt, &x.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return x, err
}

func (s *Store) Run(id int64) (Run, error) {
	return scanRun(s.db.QueryRow(`SELECT `+runCols+` FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`, id))
}

func (s *Store) CreateRun(taskID int64, trigger string, attempt int) (Run, error) {
	res, err := s.db.Exec(`INSERT INTO runs (task_id, trigger, attempt, status) VALUES (?, ?, ?, 'queued')`, taskID, trigger, attempt)
	if err != nil {
		return Run{}, err
	}
	id, _ := res.LastInsertId()
	return s.Run(id)
}

func (s *Store) StartRun(id int64, sessionID string) error {
	_, err := s.db.Exec(`UPDATE runs SET status='running', session_id=?, started_at=? WHERE id=?`, sessionID, now(), id)
	return err
}

func (s *Store) FinishRun(id int64, status, summary, errText string) error {
	_, err := s.db.Exec(`UPDATE runs SET status=?, summary=NULLIF(?, ''), error=NULLIF(?, ''), finished_at=? WHERE id=?`, status, summary, errText, now(), id)
	return err
}

// Runs lists runs newest first; taskID 0 means all tasks, status "" means any.
func (s *Store) Runs(taskID int64, status string, limit int) ([]Run, error) {
	rows, err := s.db.Query(`SELECT `+runCols+` FROM runs r JOIN tasks t ON t.id = r.task_id
		WHERE (? = 0 OR r.task_id = ?) AND (? = '' OR r.status = ?) ORDER BY r.id DESC LIMIT ?`, taskID, taskID, status, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		x, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// Active reports whether the task has a queued or running run.
func (s *Store) Active(taskID int64) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM runs WHERE task_id = ? AND status IN ('queued','running')`, taskID).Scan(&n)
	return n > 0, err
}

// Bot is a pi session presented as an assistant. The conversation, model and
// system prompt live in pi's session file; this row adds only what pi lacks.
// The bots.emoji column is unused since avatars became identicons.
type Bot struct {
	SessionID   string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Persona     string `json:"persona"`
	Cwd         string `json:"cwd"`
	Archived    bool   `json:"archived"`
	Mode        string `json:"mode"`   // trusted (native pi) | guarded (L2 gate on the main session)
	Paused      bool   `json:"paused"` // stops heartbeats, scheduled tasks and goal actions
	CreatedAt   string `json:"createdAt"`
}

// AssistantID is the built-in 助手 bot: created on first start, cannot be
// deleted or archived, can be renamed.
const AssistantID = "pm-assistant"

// Bot safety modes (docs/HISTORY.md).
const (
	ModeTrusted = "trusted"
	ModeGuarded = "guarded"
)

// botModeSchema adds the per-bot safety mode.
const botModeSchema = `ALTER TABLE bots ADD COLUMN mode TEXT NOT NULL DEFAULT 'trusted';`

// botPausedSchema adds the per-bot "pause all background activity" switch.
const botPausedSchema = `ALTER TABLE bots ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;`

// inboxIndexSchema indexes the inbox for per-job approval counts (job list),
// the unread badge and the expiry sweep.
const inboxIndexSchema = `
CREATE INDEX inbox_job ON inbox(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX inbox_status ON inbox(status);
`

const botCols = `session_id, name, description, persona, cwd, archived, mode, paused, created_at`

func scanBot(r scanner) (Bot, error) {
	var b Bot
	err := r.Scan(&b.SessionID, &b.Name, &b.Description, &b.Persona, &b.Cwd, &b.Archived, &b.Mode, &b.Paused, &b.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return b, err
}

func (s *Store) Bots() ([]Bot, error) {
	rows, err := s.db.Query(`SELECT ` + botCols + ` FROM bots ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Bot{}
	for rows.Next() {
		b, err := scanBot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) Bot(id string) (Bot, error) {
	return scanBot(s.db.QueryRow(`SELECT `+botCols+` FROM bots WHERE session_id = ?`, id))
}

func (s *Store) CreateBot(b Bot) (Bot, error) {
	if _, err := s.db.Exec(`INSERT INTO bots (session_id, name, description, persona, cwd, archived, mode, paused) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		b.SessionID, b.Name, b.Description, b.Persona, b.Cwd, b.Archived, botMode(b.Mode), b.Paused); err != nil {
		return Bot{}, err
	}
	return s.Bot(b.SessionID)
}

func (s *Store) UpdateBot(b Bot) (Bot, error) {
	res, err := s.db.Exec(`UPDATE bots SET name=?, description=?, persona=?, cwd=?, archived=?, mode=?, paused=? WHERE session_id=?`,
		b.Name, b.Description, b.Persona, b.Cwd, b.Archived, botMode(b.Mode), b.Paused, b.SessionID)
	if err != nil {
		return Bot{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Bot{}, ErrNotFound
	}
	return s.Bot(b.SessionID)
}

func botMode(m string) string {
	if m == ModeGuarded {
		return m
	}
	return ModeTrusted
}
