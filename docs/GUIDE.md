# Pimu guide

Detailed reference for using Pimu. Start with the [README](../README.md).

## Sessions and bots

Sessions come first. The new-session button (and `/new`) opens a directory
picker: the `PIMU_WORKDIRS` roots and recent cwds, subfolders to click into, a
path field (`~` works) and 新建文件夹. Everything stays inside the roots; a cwd
outside them shows one note and falls back to the default. There is no "new
bot" form. A bot is just a
session you marked as long-lived: open any session → 菜单 → **设为 Bot** (name
optional, defaults to the session title or first message; avatar is an
identicon of the session id). **取消 Bot** drops only the bot metadata (name,
persona, goals); the pi session file and the conversation stay. A bot's session
file lives in `~/.local/share/pimu/bots/<id>/session/` (moved there when you set it,
the old copy kept as `*.jsonl.pimu-moved`), so it no longer shows in a terminal
`pi -r`; open it there with `pi --session <path>` if you need to.

Home list: two tabs. **Bot** (default; busy, then waiting for approval, then
unread, then newest) and **会话**: every other session, grouped by working directory (folder-name headers; 主目录 for `$HOME`),
including sessions you started with `pi` in a terminal (marked with a terminal
icon). Task runs (`pimu-t*`), heartbeats (`pimu-g*`) and background jobs
(`pimu-j*`) are hidden there and shown under their task, goal or bot. Session ids stay in 详情, not in the list.

The conversation, model, thinking level and system prompt live in pi's session
file. Pimu's SQLite `bots` table keeps only what pi cannot: name, one-line
description, persona text, cwd, archived.

### Where things live

| What | Path |
|---|---|
| pi sessions (Pimu's and the terminal's) | `~/.pi/agent/sessions/<cwd-encoded>/*.jsonl` |
| pi settings, models, MCP, extensions | `~/.pi/agent/` |
| Pimu database (bots, tasks, runs, goals, inbox, beats) | `~/.local/share/pimu/pimu.db` (`PIMU_DATA_DIR`) |
| per-bot data: `MEMORY.md`, `goals/<slug>/{GOAL,STATE,findings}.md`, `log/` | `~/.local/share/pimu/bots/<session-id>/` |
| uploads from the composer | `<cwd>/.pimu/uploads/<session>/` |
| session locks shared with terminal pi | `~/.pi/agent/locks/` |

- Persona is passed as `--append-system-prompt` every time pi starts for that
  session; pi records it as a system section in the session file. Editing the
  persona releases an idle process so the next message uses the new one.
- Name goes to pi as `--name` (and `set_session_name` when running).
- Long chats rely on pi's own auto-compaction (on by default; see pi
  `docs/compaction.md`). Pimu adds nothing.
- Composer: 📎 images go to the model as prompt images (if pi's model entry lacks
  `"image"` in `input`, pi drops them and the UI warns). Other files are uploaded (≤25 MB, sanitized names) to
  `<cwd>/.pimu/uploads/<session>/` and their path is added to the message, so pi
  reads them with its own tools. Paste and drag-drop work too. 🎤 uses the
  browser Web Speech API (zh-CN); the button is hidden where unsupported.
- Slash: pi's built-in commands are TUI-only (docs/SLASH.md), so the composer
  handles `/compact [指示]`, `/model [p/m]`, `/thinking [lvl]`, `/name x`,
  `/session`, `/export`, `/copy`, `/new`, `/resume`, `/settings`, `/reload`
  itself (`/fork` and `/clone` point to the terminal). Everything else
  (extension commands, `/skill:*`, prompt templates) goes to pi unchanged. The
  autocomplete labels each command's source.

## Tasks

任务 (`#/tasks`) runs a prompt inside a bot (its output lands in that bot's chat
and its 任务 tab; skipped as failed while the bot is replying) or in a fresh pi
session (`pimu-t<task>-r<run>`) on a
5-field cron schedule (server local time) or on 立即运行. Each run records
status, the last assistant text as summary, and links to its session.
A failed run is retried after 1 minute up to `maxRetries` extra times; runs cut
off by a Pimu restart are marked `interrupted: pimu restarted` and retried the
same way. Missed cron slots while Pimu was down are not backfilled.

## Autonomy: goals, inbox, background jobs

Design and limits: docs/AUTONOMY.md. Needs the agent extension once:
`make install-agent` (copies `extensions/pimu-agent.ts` to
`~/.pi/agent/extensions/`; it does nothing in sessions without Pimu's env).

- **Goals** (bot → 目标) attach only to bots. Each has a `GOAL.md`, an interval
  and active hours. A zero-token precheck (enabled, active hours, due time or a
  pending event such as a webhook or an answer, limits) decides whether a beat
  is needed; each beat is a fresh pi session
  (`pimu-g<goal>-b<beat>`) that reads GOAL/STATE/findings and ends with a
  ```` ```pimu ```` action block: `noop`, `notify`, `ask`, `task`, `state`,
  `finding`. Notify is for important things only and is deduplicated.
  Webhook: `POST /api/goals/{id}/hook?k=…` (key shown masked in the UI).
- **Gate** (pimu-agent.ts): L1 = read-only tools plus writes inside the bot
  directory; L2 = anything else needs approval in the inbox. Approval is for
  one exact call (hash of tool + args), used once. Secret paths are always
  blocked.
- **Safety mode** (编辑 Bot → 安全模式): `trusted` (default) leaves the bot's main
  chat as native pi; `guarded` puts the L2 gate on it too, with approvals shown
  inline above the composer. `pimu_task` keeps working in both.
- **Hard limits**: at most 6 beats/hour, a token budget per goal per day, wall
  time per beat; three failed beats in a row disable the goal (and notify).
  The checkpoint between beats is `STATE.md` (≤4 KB, rewritten by the `state`
  action); every beat is also appended to the bot's `log/<date>.md`.
- **Inbox** (🔔 on home, or inside the bot's 目标 tab): notify / ask /
  approval items with 已读, 批准一次, 拒绝, 回答.
- **Background jobs** (bot → 任务): in a bot's chat say "放到后台做". The bot
  calls the `pimu_task` tool; Pimu starts an independent pi session
  (`pimu-j<id>`, same models, MCP and extensions, the bot's cwd, gate level
  L2) and the chat stays free. States: queued, running, waiting_approval,
  completed, failed, cancelled, interrupted, stored in SQLite.
  `PIMU_MAX_JOBS` run at once. When a job ends, its result is sent to the bot's
  main session as a follow-up and to the inbox. You can cancel a job, or steer
  a running one with an extra instruction. Jobs cut off by a restart are marked
  interrupted and never rerun on their own; you choose 重新运行 or 丢弃.

## Settings

The main UI answers two questions only: what the bot said, and what it needs from you. Everything else is opt-in.

- **Chat**: thinking and tool rows are hidden by default. While the bot works there is one quiet status line (正在运行命令… / 正在读文件…) that goes away when the answer lands. Each finished reply has a ⋯ menu (复制, 查看过程). Errors are one sentence with 重试; the raw text sits behind 详情. Compaction is a faint 已整理上下文 divider, never a toast. The header is the bot's avatar and name, plus a dot while it works; 详情 opens the bot drawer.
- **Bot drawer (详情)**: 暂停所有后台活动 (stops heartbeats, scheduled tasks and goal actions), what it is doing in the background as plain cards (正在做…, 完成了，点击查看, 停下了 + 重试), goals, schedules, and under 高级 the folder, mode, usage and the developer links.
- **Settings top level**: 外观, Bot 模式 (先问我 / 直接做 per bot), 通知 (Telegram status), 退出登录, and a collapsed 高级 (models, extensions, skills, MCP, memory, schedules).
- **外观**: mode, palette and font size up front; **显示过程** 关闭 (default) / 摘要 (a small “用了 N 个工具” line) / 全部 (every row). The rest (width, density, radius, code font and style, motion, texture, haptics, send key) is under 更多. Saved per device in `localStorage` and synced through `GET/PUT /api/prefs` (`<data-dir>/prefs.json`, newest wins). A boot script applies them before first paint, including the PWA `theme-color`.
- **高级**: 模型 (default model and thinking level; providers from `models.json` are read-only, keys masked), 扩展, Skills, MCP (`enabled` switch, 检测连接 runs `pi mcp list --json`, env and header values never sent to the browser), 记忆 (`~/.pi/agent/AGENTS.md`, `#/memory` redirects here), versions.
- Slash commands still work; they are discoverable by typing `/`.

Writes are small read-modify-write edits through temp file + rename. They carry the file's mtime, so an edit made elsewhere gives a 409 instead of being overwritten. Changes apply to new sessions.

## End-to-end tests

`make e2e` (or `e2e/run.sh`) builds Pimu, starts it on a temp agent dir and data dir with the real `pi` and a scripted mock model (`e2e/mockllm.mjs`), and drives Chrome with playwright-core through every flow: login, PWA, directory picker, streaming, abort, steer/follow-up, slash commands, uploads, bots and tabs, guarded approvals, background jobs (completed, approval, failed, queued, cancelled, interrupted), heartbeats, inbox, webhooks, settings, appearance, restart, reconnect after a server drop, the job idle watchdog, approval expiry, show-work modes, long streams, two tabs, concurrent bots, pause, budget caps, palette contrast, keyboard-only use and the phone layout. `PIMU_JOB_IDLE_SEC` and `PIMU_APPROVAL_TTL_SEC` shorten the watchdog and approval limits for tests. `ONLY=<regex>` runs a subset, `KEEP=1` keeps the temp dir (failure screenshots, logs), `e2e/run.sh serve` just starts everything. Your `~/.pi/agent` is never touched. Needs Chrome (`PW_CHROME`, default `/usr/bin/google-chrome`) and `npm i` in `e2e/` (run.sh does it).

## Browser (optional)

Pimu does not drive a browser itself. Give pi the Playwright MCP server and
the Activity tab shows its calls (filter 浏览器操作) with screenshots inline.
`~/.pi/agent/mcp.json` (needs pi's MCP support and Chrome/Chromium):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated", "--browser", "chrome",
               "--no-sandbox", "--image-responses", "allow", "--output-dir", "/tmp/pimu-pw-out"],
      "exposure": "direct"
    }
  }
}
```

`--image-responses allow` is required for screenshots to come back as images.
When the model passes a `filename`, Playwright only saves the file and returns
text, so nothing renders.

## Terminal and Pimu on the same session

Pimu holds `~/.pi/agent/locks/<id>.lock` while its pi runs a session. With the
guard extension installed, a terminal `pi --session <id>` refuses to open a
session Pimu holds. Hand it over with `pimu release <id>` (or 交给终端 in the
UI menu); while the terminal holds it, Pimu shows the session read-only and
prompts return 409.

