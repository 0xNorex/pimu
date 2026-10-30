# NOW

V1–V9 built, 2026-10-30.

- V1: Go server (pi RPC, lock, SSE replay, auth, reaper, `pimu release`), PWA chat.
- V2: SQLite tasks/runs, cron/manual runs, retry, restart recovery, Telegram, memory page.
- V3: Playwright MCP via pi's mcp.json; Activity shows screenshots.
- V4: home = bot list (bot = pi session + tiny `bots` table); persona via
  `--append-system-prompt`; tasks target a bot; composer with images, file upload, voice.
- V5/V6: identicons, one-field bot create; Settings over pi's files (models, extensions,
  skills, MCP, AGENTS.md); Geist + calm palette, CSS motion, ⌘K; gaps in docs/GAPS.md.
- Verified on box (pi 1.4.0, real model): 3 bots with personas obeyed; persona and name
  recorded in the session files; task inside a bot ran and showed in its chat; uploaded
  file read by pi via the UI; image sent from the UI described correctly by the model
  (needed `"input": ["text","image"]` in ~/.pi/agent/models.json).
- Not verified: iPhone Safari by hand (Web Speech in Home Screen app, keyboard fit),
  systemd/cloudflared, real Telegram delivery.
- Known gaps: guard in rpc mode only flags shutdown; screenshots with a `filename` arg
  return no image; unread marks are per device (localStorage).
- Measured: pimu RSS ≈ 11 MB; each pi ≈ 117–123 MB → `PIMU_MAX_PROCS=3` fits 2C3G.
- V7 (design): docs/SLASH.md, docs/AUTONOMY.md.
- V8: sessions first (+ = new session, 设为 Bot on any session, home grouped by cwd);
  autonomy P1 (goals + heartbeat with zero-token precheck, ```pimu action block,
  pimu-agent.ts L1/L2 gate, inbox with approve-once, webhook, limits, STATE.md);
  background jobs (`pimu_task` tool → `pimu-j*` session, queue `PIMU_MAX_JOBS`,
  restart → interrupted, result followUp into the bot); composer slash interception.
- Verified with the real model (box): noop beat; notify beat with dedup; L2 approval
  round-trip (approved call ran once); webhook dedup; delegation (chat answered while the
  job waited/ran, steer reached the job, result came back to the main session);
  restart → interrupted, not rerun; rerun/cancel; queue of 2; /compact 26948 → ~11897.
- Not verified: very long waits inside the gate's tool_call; whether bot MEMORY.md
  injection reaches the prompt; gating of nested tools; 3-failure auto-disable,
  6/hour cap and daily token cap not hit; Telegram with a real token.
- Known P1 limits: an approval hash, once used, blocks the identical call again; an
  approved but never re-called approval stays approved; bot main sessions carry the
  internal token in env (needed by `pimu_task`), so the model could read it via `env`.
- V9 (local hardening, docs/V9.md): scoped capability tokens instead of the server
  token in children; single-use, scoped, expiring approvals; stricter gate; `go test ./...`
  with a fake pi. Real-model checklist 8/8 passed on the box (skills loading and live
  nested tools not exercised). The P1 limits above are fixed; open risks are in docs/V9.md.
