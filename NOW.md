# NOW

V1–V3 built, 2026-10-30.

- V1: Go server (pi RPC, lock, SSE replay, auth, reaper, `pimu release`), PWA chat, guard extension.
- V2: SQLite tasks/runs, cron + manual runs, retry, restart recovery, Telegram notify,
  global `/api/events`, 正在进行 on home, memory page (AGENTS.md, mtime 409).
- V3: Playwright MCP via pi's mcp.json; Activity shows screenshots + 浏览器操作 filter.
- Verified on box (pi 1.4.0, real model): cron fired and ran, manual run, restart → interrupted
  → retry 1 min later succeeded, memory PUT + 409, browser screenshot rendered in Activity.
- Telegram: request shape checked against a local listener; real API answered 401 to a
  fake token. Real delivery not verified (no bot token).
- Not verified: iPhone Safari manual checks, systemd/cloudflared, `make` (no make on box).
- Known gaps: guard in rpc mode only flags shutdown (pi limitation); screenshots with a
  `filename` arg return no image; task sessions fill the session list; no tests by choice.
- Measured: pimu RSS ≈ 11 MB; each pi ≈ 117–123 MB → `PIMU_MAX_PROCS=3` fits 2C3G.
