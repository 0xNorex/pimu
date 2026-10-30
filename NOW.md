# NOW

V1–V4 built, 2026-10-30.

- V1: Go server (pi RPC, lock, SSE replay, auth, reaper, `pimu release`), PWA chat.
- V2: SQLite tasks/runs, cron/manual runs, retry, restart recovery, Telegram, memory page.
- V3: Playwright MCP via pi's mcp.json; Activity shows screenshots.
- V4: home = bot list (bot = pi session + tiny `bots` table); persona via
  `--append-system-prompt`; tasks target a bot; composer with images, file upload, voice.
- Verified on box (pi 1.4.0, real model): 3 bots with personas obeyed; persona and name
  recorded in the session files; task inside a bot ran and showed in its chat; uploaded
  file read by pi via the UI; image prompt accepted and ignored by the text-only model.
- Not verified: iPhone Safari by hand (incl. Web Speech in a Home Screen app),
  systemd/cloudflared, real Telegram delivery, a vision model.
- Known gaps: guard in rpc mode only flags shutdown; screenshots with a `filename` arg
  return no image; unread marks are per device (localStorage); no tests by choice.
- Measured: pimu RSS ≈ 11 MB; each pi ≈ 117–123 MB → `PIMU_MAX_PROCS=3` fits 2C3G.
