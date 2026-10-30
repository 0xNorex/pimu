# History

What was built, what was checked with a real model on the box, and what was not.
Design references: [DESIGN.md](DESIGN.md), [AUTONOMY.md](AUTONOMY.md), [SLASH.md](SLASH.md).

## V1–V8 (2026-10)

- V1: Go server (pi RPC, session lock, SSE replay, auth, idle reaper, `pimu release`), PWA chat.
- V2: SQLite tasks/runs, cron and manual runs, retry, restart recovery, Telegram.
- V3: Playwright MCP through pi's `mcp.json`; the Activity tab shows screenshots.
- V4–V6: bots (a pi session plus a small `bots` row), personas via
  `--append-system-prompt`, composer with images, files and voice, identicons,
  Settings over pi's own files, ⌘K, calm palette.
- V7: designs for slash commands and autonomy.
- V8: sessions first (**+** = new session, 设为 Bot on any session); goals with a
  heartbeat and a zero-token precheck; the `pimu-agent.ts` L1/L2 gate; inbox with
  approve-once; webhook; background jobs (`pimu_task` → `pimu-j*` session, queue,
  restart → interrupted, result sent back to the bot).
- Measured: pimu RSS ≈ 11–21 MB, each pi ≈ 120 MB, so `PIMU_MAX_PROCS=3` fits 2C3G.

## V9 local hardening

- Children get a per-session capability (`X-Pimu-Cap`, scoped to session, bot, goal,
  job) through a 0600 file the extension reads and unlinks; the server token never
  reaches a child. Pimu scrubs `PIMU_*` from its env and sets `PR_SET_DUMPABLE=0`.
- Approvals: hash of bot + goal + job + tool + canonical args, computed server-side;
  approved → claimed once (`used`); denied holds 24h; pending 24h, approved 2h, then
  `expired`; a restart expires waiting ones.
- Gate: `/proc/`, secret paths and other bots' data dirs blocked at every level;
  strict read-only bash allowlist; dangerous commands hard-blocked in jobs; nested
  tool calls go through the same handler.
- Real-model checklist 8/8 on the box: concurrent jobs, approval → resume, UI refresh
  mid-run, `kill -9` → interrupted and approval expired, heartbeat continuity,
  duplicate approval rejected, Playwright steps in the UI, SSE reconnect banner.

## V10 controlled autonomy

- Per-bot `mode`: `trusted` (default, native pi) or `guarded` (L2 gate on the main
  session, `pimu_task` still allowed, dangerous commands ask instead of block).
  Main-session approvals (goal 0 / job 0) are accepted only for guarded bots and show
  inline above the composer and in the inbox. Switching mode releases an idle pi at
  once; a replying one keeps its mode until it next starts.
- Jobs carry approval counts from Pimu's records; the job card shows them and the
  result sent back to the bot gets `[Pimu] approvals: N requested, a approved, d denied`.
- Verified: trusted unchanged; guarded inline approve → write ran once; guarded bot
  delegated a job with 3 approvals (2 approved, 1 denied) and the main bot repeated the
  right counts; idle mode switch took effect on the next message.

## Cleanup and performance (after V10)

Dead code removed (unused hub method, two unused UI components, stray exports, a
duplicate model fetch); V9/V10/NOW notes and the stale competitor matrix merged here.

| Measure | Before | After |
|---|---|---|
| Home first load, 390×844, 4× CPU, ~6 Mbps/100 ms | 1.69 s, 803 KB | 0.78 s, 150 KB |
| Initial JS (raw) | 713 KB in one file | 411 KB (pages lazy-loaded) |
| Job list, 2 000 jobs / 20 000 inbox rows | 63 ms | 1.4 ms |
| Unread badge count, same DB | 1.3 ms | 6 µs |
| Session lookup by id, 1 000 sessions | 1.6 ms | 5.6 µs |
| SSE publish with a full replay ring | 61 µs, 240 KB alloc | 0.12 µs |
| Binary (`-s -w`) / idle RSS | 13.6 MB / 16 MB | 13.7 MB / 16 MB |

## V11 chat polish

- Thinking and tool rows: 36 px rows, 4 px apart when consecutive (was 44 px, 12 px).
- pi's built-in `codemode` tool (enable with `"defaultTools": ["+codemode"]`, see
  pi `docs/codemode.md`): the script shows as highlighted JavaScript instead of escaped
  JSON, the nested calls from `details.calls` show with status, args, time and error,
  and the `Script completed` header is dropped from the output. Nested calls stay out
  of the timeline and the Activity tab, as in pi's TUI. The gate already treated
  `codemode` as `reachesTools`, so each nested call is gated on its own.

## Open risks and not verified

- Neither mode is an OS sandbox; pi runs as the local user. Same uid can read pi's
  process memory (a job's cap only grants its own scope). A later extension could
  change `tool_call.input` after the gate.
- In guarded mode, MCP tools without `readOnlyHint` (e.g. `browser_navigate`) ask.
- Not verified: iPhone Safari by hand, Telegram delivery, very long gate waits, the
  daily token cap, switching mode while a reply is streaming, systemd/cloudflared.
