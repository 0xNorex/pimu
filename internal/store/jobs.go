package store

import (
	"database/sql"
	"errors"
)

// jobsSchema is migration 4: background jobs a bot delegates (pimu_task), and
// an inbox that can belong to a goal or a job. SQLite cannot relax NOT NULL in
// place, so inbox is rebuilt and its rows copied over unchanged.
const jobsSchema = `
CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  bot_id      TEXT    NOT NULL REFERENCES bots(session_id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_approval','completed','failed','interrupted','cancelled')),
  session_id  TEXT    NOT NULL DEFAULT '',
  result      TEXT    NOT NULL DEFAULT '',
  error       TEXT    NOT NULL DEFAULT '',
  tokens      INTEGER NOT NULL DEFAULT 0,
  delivered   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_bot ON jobs(bot_id, id DESC);
CREATE INDEX jobs_open ON jobs(status) WHERE status IN ('queued','running','waiting_approval');
CREATE TABLE inbox_new (
  id         INTEGER PRIMARY KEY,
  bot_id     TEXT    NOT NULL REFERENCES bots(session_id) ON DELETE CASCADE,
  goal_id    INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  job_id     INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('notify','ask','approval')),
  dedup_key  TEXT    NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT '',
  tool       TEXT    NOT NULL DEFAULT '',
  args_hash  TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','approved','denied','used','expired')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
INSERT INTO inbox_new (id, bot_id, goal_id, kind, dedup_key, title, body, tool, args_hash, status, created_at, decided_at)
  SELECT i.id, g.bot_id, i.goal_id, i.kind, i.dedup_key, i.title, i.body, i.tool, i.args_hash, i.status, i.created_at, i.decided_at
  FROM inbox i JOIN goals g ON g.id = i.goal_id;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
CREATE UNIQUE INDEX inbox_dedup ON inbox(bot_id, COALESCE(goal_id, 0), COALESCE(job_id, 0), dedup_key);
`

type Job struct {
	ID         int64   `json:"id"`
	BotID      string  `json:"botId"`
	Title      string  `json:"title"`
	Prompt     string  `json:"prompt"`
	Status     string  `json:"status"`
	SessionID  string  `json:"sessionId"`
	Result     string  `json:"result"`
	Error      string  `json:"error"`
	Tokens     int     `json:"tokens"`
	Delivered  bool    `json:"delivered"`
	CreatedAt  string  `json:"createdAt"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	// Approvals is counted from Pimu's approval records, not stored.
	Approvals ApprovalStats `json:"approvals"`
}

const jobCols = `id, bot_id, title, prompt, status, session_id, result, error, tokens, delivered, created_at, started_at, finished_at`

func scanJob(r scanner) (Job, error) {
	var j Job
	err := r.Scan(&j.ID, &j.BotID, &j.Title, &j.Prompt, &j.Status, &j.SessionID, &j.Result, &j.Error, &j.Tokens, &j.Delivered, &j.CreatedAt, &j.StartedAt, &j.FinishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return j, err
}

func (s *Store) queryJobs(q string, args ...any) ([]Job, error) {
	rows, err := s.db.Query(`SELECT `+jobCols+` FROM jobs `+q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range out {
		out[i].Approvals, _ = s.JobApprovalStats(out[i].ID)
	}
	return out, nil
}

func (s *Store) CreateJob(botID, title, prompt string) (Job, error) {
	res, err := s.db.Exec(`INSERT INTO jobs (bot_id, title, prompt) VALUES (?, ?, ?)`, botID, title, prompt)
	if err != nil {
		return Job{}, err
	}
	id, _ := res.LastInsertId()
	return s.Job(id)
}

func (s *Store) Job(id int64) (Job, error) {
	j, err := scanJob(s.db.QueryRow(`SELECT `+jobCols+` FROM jobs WHERE id = ?`, id))
	if err == nil {
		j.Approvals, _ = s.JobApprovalStats(id)
	}
	return j, err
}

// Jobs lists a bot's jobs, newest first ("" = all bots).
func (s *Store) Jobs(botID string, limit int) ([]Job, error) {
	return s.queryJobs(`WHERE (? = '' OR bot_id = ?) ORDER BY id DESC LIMIT ?`, botID, botID, limit)
}

// QueuedJobs is the FIFO queue; UndeliveredJobs are finished jobs whose result
// has not reached the bot's main session yet.
func (s *Store) QueuedJobs() ([]Job, error) {
	return s.queryJobs(`WHERE status = 'queued' ORDER BY id`)
}

func (s *Store) UndeliveredJobs() ([]Job, error) {
	return s.queryJobs(`WHERE status IN ('completed','failed','cancelled') AND delivered = 0 ORDER BY id`)
}

// QueuePos is how many queued jobs are ahead of id (0 = next).
func (s *Store) QueuePos(id int64) int {
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM jobs WHERE status = 'queued' AND id < ?`, id).Scan(&n)
	return n
}

// SetJobStatus moves a job to status if it is currently in one of from.
func (s *Store) SetJobStatus(id int64, status string, from ...string) (bool, error) {
	q := `UPDATE jobs SET status = ? WHERE id = ?`
	args := []any{status, id}
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

func (s *Store) StartJob(id int64, sessionID string) (bool, error) {
	res, err := s.db.Exec(`UPDATE jobs SET status = 'running', session_id = ?, started_at = ? WHERE id = ? AND status = 'queued'`, sessionID, now(), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) FinishJob(id int64, status, result, errText string, tokens int) error {
	_, err := s.db.Exec(`UPDATE jobs SET status = ?, result = ?, error = ?, tokens = ?, finished_at = ? WHERE id = ?`, status, result, errText, tokens, now(), id)
	return err
}

func (s *Store) SetJobDelivered(id int64) error {
	_, err := s.db.Exec(`UPDATE jobs SET delivered = 1 WHERE id = ?`, id)
	return err
}

// InterruptJobs marks jobs left running by a previous process; they are never
// re-run automatically — the user decides (rerun or drop).
func (s *Store) InterruptJobs() (int64, error) {
	res, err := s.db.Exec(`UPDATE jobs SET status = 'interrupted', finished_at = ?, error = 'Pimu 重启时它还在运行' WHERE status IN ('running','waiting_approval')`, now())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	_, err = s.db.Exec(`UPDATE inbox SET status = 'expired' WHERE kind = 'approval' AND status IN ('new','read','approved')
		AND job_id IN (SELECT id FROM jobs WHERE status NOT IN ('running','waiting_approval'))`)
	return n, err
}

// ExpireJobItems closes approvals a finished job can no longer use.
func (s *Store) ExpireJobItems(jobID int64) error {
	_, err := s.db.Exec(`UPDATE inbox SET status = 'expired' WHERE job_id = ? AND kind = 'approval' AND status IN ('new','read','approved')`, jobID)
	return err
}
