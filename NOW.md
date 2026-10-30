# NOW

V1 (Chat + RPC) built, 2026-10-30.

- Done: Go server (pi RPC proc, lock, SSE + replay, token/cookie auth, idle reaper,
  `pimu release`), embedded PWA (list, chat stream, tools, steer/followUp/abort,
  model/thinking, `/` commands, extension dialogs, Activity tab), pimu-guard extension.
- Verified on box with pi 1.4.0 + a local stub model (no real API key).
- Not verified: iPhone Safari manual checks, real-model runs, systemd/cloudflared,
  `make` itself (no make on build box; commands run by hand).
- Known gaps: guard in `pi --mode rpc` only flags shutdown (pi limitation);
  pi may write metadata before extensions run (pi#8300); no tests by choice.
- Measured: pimu RSS ≈ 11 MB; each pi ≈ 117–123 MB → `PIMU_MAX_PROCS=3` fits 2C3G.
- Next: V1.1 image upload, then V2 (SQLite tasks/runs, Telegram, memory page).
