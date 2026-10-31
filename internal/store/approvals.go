package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

// Approval lifecycle (docs/HISTORY.md). One inbox row per request, keyed by
// (bot, goal|job, args hash), where the hash is computed by Pimu from the
// tool and its canonical arguments:
//
//	new/read --approve--> approved --claim--> used     (the call runs once)
//	new/read --deny-----> denied                       (repeats blocked for DeniedHold)
//	new/read --PendingTTL--> expired; approved --ApprovedTTL--> expired
//
// Claiming is one conditional UPDATE, so of two identical calls racing on
// one approval only one runs. The row is marked used before the tool runs:
// a crash or retry can never run it a second time; an identical later call
// files a fresh request instead.
var (
	PendingTTL  = envTTL("PIMU_APPROVAL_TTL_SEC", 24*time.Hour) // unanswered requests (env: tests)
	ApprovedTTL = 2 * time.Hour
	DeniedHold  = 24 * time.Hour
)

func envTTL(name string, def time.Duration) time.Duration {
	if n, err := strconv.Atoi(os.Getenv(name)); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return def
}

const approvalsSchema = `
ALTER TABLE inbox ADD COLUMN used_by TEXT NOT NULL DEFAULT '';
`

// Verdicts returned by Approve and ApprovalStatus.
const (
	VerdictRun     = "run" // claimed now: run the call
	VerdictPending = "pending"
	VerdictDenied  = "denied"
	VerdictGone    = "gone" // used or expired; not usable
)

// ExpireApprovals closes stale requests and stale unused approvals.
func (s *Store) ExpireApprovals() (int64, error) {
	t := Clock()
	res, err := s.db.Exec(`UPDATE inbox SET status = 'expired' WHERE kind = 'approval' AND
		((status IN ('new','read') AND created_at < ?) OR (status = 'approved' AND decided_at < ?))`,
		ts(t.Add(-PendingTTL)), ts(t.Add(-ApprovedTTL)))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Approve is what the gate asks for each risky call. ref records who claimed
// it (session/tool call id). It returns the row and a verdict; isNew reports a
// freshly filed request (to notify the user).
func (s *Store) Approve(it Item, ref string) (out Item, verdict string, isNew bool, err error) {
	// goal 0 and job 0 is the bot's main session (guarded mode, docs/HISTORY.md).
	if it.BotID == "" || it.ArgsHash == "" || (it.GoalID != 0 && it.JobID != 0) {
		return Item{}, "", false, errors.New("approval needs bot, args hash and at most one of goal/job")
	}
	if _, err := s.ExpireApprovals(); err != nil {
		return Item{}, "", false, err
	}
	var id int64
	var status string
	var decided sql.NullString
	err = s.db.QueryRow(`SELECT id, status, decided_at FROM inbox WHERE kind = 'approval' AND bot_id = ? AND COALESCE(goal_id,0) = ? AND COALESCE(job_id,0) = ? AND args_hash = ? ORDER BY id DESC LIMIT 1`,
		it.BotID, it.GoalID, it.JobID, it.ArgsHash).Scan(&id, &status, &decided)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Item{}, "", false, err
	}
	switch {
	case err == nil && status == "approved":
		if ok, err := s.claim(id, ref); err != nil || ok {
			out, _ = s.Item(id)
			return out, VerdictRun, false, err
		}
		// lost the race: the approval was just used by an identical call
	case err == nil && (status == "new" || status == "read"):
		out, err = s.Item(id)
		return out, VerdictPending, false, err
	case err == nil && status == "denied" && decided.Valid && decided.String > ts(Clock().Add(-DeniedHold)):
		out, err = s.Item(id)
		return out, VerdictDenied, false, err
	}
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM inbox WHERE kind = 'approval' AND bot_id = ? AND args_hash = ?`, it.BotID, it.ArgsHash).Scan(&n)
	it.Kind, it.DedupKey = "approval", fmt.Sprintf("ap:%s:%d", it.ArgsHash, n+1)
	out, isNew, err = s.AddItem(it)
	return out, VerdictPending, isNew, err
}

// ApprovalStatus is polled by a waiting job; an approved row is claimed.
func (s *Store) ApprovalStatus(id int64, ref string) (string, error) {
	if _, err := s.ExpireApprovals(); err != nil {
		return "", err
	}
	it, err := s.Item(id)
	if err != nil {
		return "", err
	}
	switch it.Status {
	case "new", "read":
		return VerdictPending, nil
	case "approved":
		ok, err := s.claim(id, ref)
		if ok {
			return VerdictRun, err
		}
		return VerdictGone, err
	case "denied":
		return VerdictDenied, nil
	}
	return VerdictGone, nil
}

func (s *Store) claim(id int64, ref string) (bool, error) {
	res, err := s.db.Exec(`UPDATE inbox SET status = 'used', decided_at = ?, used_by = ? WHERE id = ? AND status = 'approved'`, now(), ref, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// ApprovalStats counts a job's approval requests from Pimu's own records, so
// the result reported to the bot does not depend on the worker's account.
type ApprovalStats struct {
	Requested int `json:"approval_count"`
	Approved  int `json:"approved"` // approved or used
	Denied    int `json:"denied"`
	Expired   int `json:"expired"`
	Pending   int `json:"pending"`
}

func (s *Store) JobApprovalStats(jobID int64) (ApprovalStats, error) {
	var a ApprovalStats
	err := s.db.QueryRow(`SELECT count(*),
		COALESCE(sum(status IN ('approved','used')),0), COALESCE(sum(status = 'denied'),0),
		COALESCE(sum(status = 'expired'),0), COALESCE(sum(status IN ('new','read')),0)
		FROM inbox WHERE kind = 'approval' AND job_id = ?`, jobID).Scan(&a.Requested, &a.Approved, &a.Denied, &a.Expired, &a.Pending)
	return a, err
}

// Line is the factual summary appended to a job result for the bot.
func (a ApprovalStats) Line() string {
	s := fmt.Sprintf("[Pimu] approvals: %d requested, %d approved, %d denied", a.Requested, a.Approved, a.Denied)
	if a.Expired > 0 {
		s += fmt.Sprintf(", %d expired", a.Expired)
	}
	if a.Pending > 0 {
		s += fmt.Sprintf(", %d pending", a.Pending)
	}
	return s
}
