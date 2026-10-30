# Pimu · 设计文档 v1

> **Pimu — Not another agent harness. Just Pi, everywhere.**
> Pi + Muse：A tiny, always-on workspace for Pi。

调研日期：2026-10-30（Asia/Shanghai）。所有版本号为当日查询结果。标 **【不确定】** 的内容在动手前需要先验证。

---

## 0. 一句话定位与非目标

**定位**：一个 Go 单二进制，把原版 `pi --mode rpc` 子进程托管成常驻服务，让你从 iPhone/电脑的 PWA 上**看到、控制、续写**同一批 Pi 会话；之后加上定时任务和通知。

**原则（按优先级）**
1. Pi 是唯一的 Agent 核心。Pimu 不碰 prompt 组装、工具执行、模型配置、MCP、skills、compaction。
2. 与 Pi CLI 共用同一 OS 用户、`~/.pi/agent`（`PI_CODING_AGENT_DIR`）、会话 JSONL、扩展。Pimu **只读**会话文件，所有写入都经由 pi 进程完成。
3. 同一会话同一时刻只能有一个 pi 进程（Pimu 或终端）持有：锁文件 + 守卫扩展（§3.3）。
4. KISS / YAGNI：能用 pi 已有机制就不新建；能不加依赖就不加。

**非目标（V1–V3 都不做）**
- 多 Agent 编排、子 Agent、计划模式（pi 本身也刻意不做）
- 云桌面、VNC、远程终端（xterm）
- 插件市场、Pimu 自己的扩展系统
- 多用户、团队、权限体系
- 自研记忆系统、向量库、RAG
- 自研工具（Shell/Files/Browser 都由 pi 的工具或 MCP 提供）
- Web Push（iOS 需 VAPID + 加密依赖；用 Telegram 代替）
- 文件管理器 / Git diff 浏览器（`agegr/pi-web` 已做，见 §1）
- 在 Web 里编辑 pi 的 models/auth/settings（用终端 `pi` 的 `/login`、`/settings`）

---

## 1. 调研结论（含来源）

| # | 结论 | 来源 |
|---|---|---|
| 1 | “Pi CLI” = `earendil-works/pi` 单仓里的 coding agent（原 `badlogic/pi-mono`，已迁移，★118869），npm 包 **`@earendil-works/pi-coding-agent` 1.4.0**（不是旧的 `@mariozechner/...`），命令 `pi`，需 **Node.js 22.19+**。最新 release `v1.4.0`（2026-10-22 06:49 UTC+8）。 | https://github.com/earendil-works/pi , packages/coding-agent/package.json |
| 2 | RPC：`pi --mode rpc`，stdin/stdout **严格 JSONL**（只按 `\n` 切分，**不能**按 U+2028/U+2029 切），命令带可选 `id`，响应 `{"type":"response","command":..,"success":..,"id":..}`；事件无 id。`prompt` 成功只表示被接受（`disposition: started|queued|handled`），**以 `agent_settled` 为真正结束**。流式中再发 `prompt` 必须带 `streamingBehavior: "steer"|"followUp"`。关闭 stdin = 优雅退出。stdout 必须持续读，否则 pi 会被背压卡住。 | docs/rpc.md, rpc-commands.md, json.md |
| 3 | 会话：`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`，v3 格式，首行 header `{"type":"session","version":3,"id","cwd",...}`，其余是 `id/parentId` 树形 append-only 条目（`message`、`model_change`、`compaction`、`session_info`...）。可用 `--session <path|id>`、`--session-id <id>`（不存在则创建）、`--session-dir`、`PI_CODING_AGENT_SESSION_DIR`。MCP 已内建（`~/.pi/agent/mcp.json`，`pi mcp add`）；skills/extensions/prompts 在 `~/.pi/agent/` 下；扩展的 dialog（`select/confirm/input/editor`）在 RPC 中变为 `extension_ui_request/response` 子协议。 | docs/session-format.md, sessions.md, configuration.md, mcp.md, rpc-extension-ui.md |
| 4 | **pi 核心没有会话锁**：两个进程可同时 append 同一 JSONL，产生分叉分支（issue #8300，2026-10-03 在 1.0.3 仍复现，被自动关闭未修）。社区用扩展在 `session_start` 加锁，但 pi 在钩子前可能已写入 `model_change`/`thinking_level_change`。→ Pimu 必须自己做锁，且只能“尽量”防住 CLI 侧。 | https://github.com/earendil-works/pi/issues/8300 |
| 5 | 同类项目很多，重叠度高：**`agegr/pi-web`**（★7911，Next 16.3.8 + 直接用 pi SDK，同目录同会话、PWA、密码、10 分钟空闲回收）；`kkkiio/pi-web-ui`（★15，作为 pi 扩展运行在终端 pi 进程内，Vite+Tailwind+shadcn/ui+AI Elements，终端与浏览器同屏同步）；`The-Vibe-Company/companion`（★2411，“Persistent AI companions powered by Pi”，React+shadcn+Postgres，偏托管产品）；`happier-dev/happier`、`agent-of-empires`（多 agent 移动端客户端，均支持 Pi）。**“Muse”** = Meta 的个人 Agent Muse（muse.ai）：活动日志（头像下显示当前在做什么，点开看完整 activity log 和已授权权限）、Goals 页、后台定时任务、“只在有意义时通知”。 | https://github.com/agegr/pi-web , https://github.com/kkkiio/pi-web-ui , https://github.com/The-Vibe-Company/companion , https://introducing.muse.ai/ |

**差异化（Pimu 存在的理由）**：pi-web 是“本地浏览器 UI”（Node，按需开），Pimu 是“常驻服务 + 移动优先 + 定时任务 + 通知 + Go 单二进制 + 严格不写会话文件”。若只要 Web 聊天，`npx @agegr/pi-web` 即可——这是要提醒用户的事实。

**可复用 / 避免重复造轮子**
- RPC 协议直接照抄官方类型：`packages/coding-agent/src/modes/rpc/rpc-types.ts`、`rpc-client.ts`（Go 侧手写最小子集）。
- Browser：用 pi 已支持的 MCP 接 `@playwright/mcp`（0.0.83），**不在 Go 里写 Playwright**。
- Memory：pi 已加载 `<agent-dir>/AGENTS.md` 作为全局上下文，直接把它当长期记忆。
- 聊天 UI 的交互细节可参考 pi-web（工具折叠、上下文用量、分支）与 kkkiio/pi-web-ui（shadcn 组合）。

---

## 2. 技术选型（修正后）

| 层 | 选择 | 理由 |
|---|---|---|
| Agent | 原版 `pi`（`@earendil-works/pi-coding-agent` ≥1.4.0）`--mode rpc` | 进程隔离、语言无关、官方协议；不 fork、不改核心 |
| 后端语言 | Go 1.26+（当前稳定 1.27.3） | 单二进制、低内存，适合 2C3G |
| HTTP | 标准库 `net/http`（1.22+ 路由模式 `GET /api/x/{id}`） | 零依赖 |
| 实时 | **SSE（GET）+ 普通 POST** | 单向推送足够；`EventSource` 自动重连 + `Last-Event-ID`；Cloudflare Tunnel 友好；不需要 WebSocket 依赖 |
| 存储 | SQLite，`modernc.org/sqlite` v1.61.0（纯 Go，免 CGO） | 交叉编译/部署简单；数据量极小，性能差异无关。`mattn/go-sqlite3` v1.14.52 需 CGO，弃 |
| 何时用 SQLite | **V2 才建库**：`tasks`、`runs`；V4 加一张小表 `bots`（只存 pi 会话文件放不下的展示信息：emoji、简介、人设、cwd、归档、名字） | 会话、模型、系统提示、压缩仍归 pi；Bot 就是 pi 会话 |
| Cron | `github.com/robfig/cron/v3` v3.0.1（V2） | 事实标准，稳定多年不变 |
| Telegram | 标准库直接调 Bot API `sendMessage`（V2，仅出站通知） | 一个 HTTP POST，不值得引库 |
| Browser | pi 侧配置 `@playwright/mcp`（V3） | Pi 仍是唯一 Agent；Pimu 只展示截图/记录 |
| 前端 | **Vite 8.x + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui（CLI 4.23.0）** | shadcn 依赖 React+Tailwind，故修正“原生 TS”；Vite 是最轻的 React 构建；不用 Next |
| 前端路由 | 无路由库，`location.hash` + 一个 `useHashRoute()` hook | 4 个页面不值得 react-router |
| 前端状态 | `useReducer` + Context + 一个 SSE 连接 | 不引 Zustand/Redux/React Query |
| Markdown | `react-markdown` + `remark-gfm` | 唯二额外运行时依赖；不做代码高亮（V1） |
| 资源嵌入 | `//go:embed all:dist` | 单二进制部署 |
| 日志 | `log/slog`（JSON 输出到 stdout → journald） | 标准库 |
| 安全 | Cloudflare Tunnel + Access（邮箱 OTP）+ 应用 token；Pimu 只监听 127.0.0.1 | 两层：边缘鉴权 + 应用鉴权 |
| 部署 | systemd 用户服务（与 pi 同用户） | 共用 `~/.pi`、Node、凭据 |

**依赖白名单（超出需在 PR 里说明理由）**
- Go：`modernc.org/sqlite`（V2）、`github.com/robfig/cron/v3`（V2）。V1 **零第三方依赖**。
- npm 运行时：`react`、`react-dom`、`react-markdown`、`remark-gfm`，以及 shadcn CLI 自动带入的（`radix-ui`/`@radix-ui/*`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`sonner`、`tw-animate-css`）。
- npm 开发：`vite`、`@vitejs/plugin-react`、`typescript`、`tailwindcss`、`@tailwindcss/vite`、`eslint` + `typescript-eslint`（可选）。
- 禁止：react-router、状态管理库、react-query/SWR、zod/react-hook-form、cmdk（不用 shadcn `command`）、任何 CSS-in-JS、axios、moment/dayjs（用 `Intl`）。

---

## 3. 进程模型

### 3.1 总览

```
pimu serve (1 个 Go 进程)
 ├─ HTTP/SSE  127.0.0.1:7777
 ├─ Hub: map[sessionID]*Proc     （最多 PIMU_MAX_PROCS 个，默认 3）
 │    └─ Proc = exec `pi --mode rpc --session <path>`（cwd = 会话 header.cwd）
 │         stdin  ← JSONL 命令（写锁串行化）
 │         stdout → reader goroutine → 响应分发 / 事件广播(ring buffer)
 │         stderr → slog(debug) + 最近 50 行环形缓冲（崩溃时展示）
 ├─ Reaper: 空闲 PIMU_IDLE_TIMEOUT(默认 10m) 且非 streaming → 关闭 stdin，释放锁
 └─ (V2) Scheduler: cron → Runner（复用同一 Hub 与并发上限）
```

### 3.2 启动 / 通信 / 关闭

- 新建会话：Pimu 生成 `id = "pm-" + 12位小写hex`，先取锁，再 `pi --mode rpc --session-id <id>`，cwd 为用户选择的目录（必须在 `PIMU_WORKDIRS` 白名单内）。启动后发 `get_state` 拿 `sessionFile`。
- 续写已有会话：先取锁，再 `pi --mode rpc --session <path>`。
- 额外参数：`PIMU_PI_ARGS`（如 `--approve`）原样追加。环境：继承 Pimu 环境 + `PIMU_LOCK_OWNER=<sessionID>`（给守卫扩展识别自己人）。
- `SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}`：Pimu 死，pi 跟着死。
- 读 stdout：`bufio.Reader.ReadBytes('\n')`，去掉末尾 `\r`。**不要**用 `bufio.Scanner`（64KB 行限制，工具输出会超）。
- 请求关联：`id = "r<自增>"`，`pending map[string]chan Response`，命令超时 30s（`abort` 60s）。响应不广播；事件全部广播。
- 关闭顺序：`abort`（若 streaming 且是用户 release）→ 关 stdin → 等 5s → `SIGTERM` 进程组 → 等 5s → `SIGKILL` → 释放锁。
- `pimu serve` 收到 SIGTERM：对所有 Proc 执行上述关闭（并行，总时限 15s）。

### 3.3 会话锁（防 CLI 与 WebUI 并发写）

pi 核心无锁（issue #8300），因此两部分：

**A. 锁文件（Go 与扩展共用约定）**
- 路径：`<agent-dir>/locks/<sessionID>.lock`（`<agent-dir>` = `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）。按 session ID 而非文件路径，因为新会话启动前路径未知。
- 获取：`O_CREATE|O_EXCL` 创建，写入 `{"pid":<持有者pid>,"owner":"pimu"|"pi-cli","host":"<hostname>","at":"<RFC3339>"}`。
- 已存在：读 pid；`kill(pid,0)` 失败（ESRCH）或 host 不同且超过 24h → 视为陈旧，删除后重试一次；否则返回 **busy**。
- Pimu 写自己的 pid（不是 pi 子进程 pid）：Pimu 崩溃后 pid 失效，锁自然陈旧。
- 不用 `flock`：Node 标准库没有 flock，两边必须用同一机制。

**B. 守卫扩展 `extensions/pimu-guard.ts`（安装到 `~/.pi/agent/extensions/`，约 40 行）**
- `session_start`：若 `process.env.PIMU_LOCK_OWNER === ctx.sessionManager.getSessionId()` → 放行（这是 Pimu 拉起的）。否则按 A 尝试以 `owner:"pi-cli"` 获取；busy → `ctx.ui.notify("该会话正被 Pimu 使用：pimu release <id> 后重试，或用 --fork", "error")` 后 `ctx.shutdown()`。
- `session_before_switch`（`/resume` 切换）：目标会话被占用则取消切换。
- `session_shutdown`：删除自己持有的锁。
- **已知缺口**：pi 在扩展钩子运行前可能已向文件追加 `model_change`/`thinking_level_change` 条目（#8300 评论）。这只是元数据条目，可接受；文档里写明“尽量不要两边同时打开”。

**C. 用户体验**
- WebUI 打开被 CLI 占用的会话：只读浏览（Pimu 直接读 JSONL），顶部 banner “终端 pi 正在使用此会话”，输入框禁用。
- 终端想接管 Pimu 的会话：`pimu release <id>`（调本地 API）或在 UI 点“交给终端”，然后 `pi --session <id>`。
- 空闲 10 分钟自动释放，所以大多数情况下无感。

### 3.4 崩溃恢复

| 情况 | 处理 |
|---|---|
| pi 子进程意外退出 | 广播 `pimu` 事件 `{type:"proc_exit",code,stderrTail}`；删除 Proc；释放锁。**不自动重启**；下次 POST prompt 时懒启动。会话内容由 pi 已落盘，无需恢复 |
| pi 启动失败（如 Node 不存在） | `POST` 返回 502 + stderr 尾部；UI 显示错误卡片 |
| Pimu 崩溃/重启 | 子进程因 Pdeathsig 退出；残留锁因 pid 失效在下次获取时清除；SSE 客户端自动重连后收到 `resync` |
| 命令超时 | 返回 504；不杀进程（可能只是 pi 忙）。连续 3 次超时 → 杀掉重来 |
| (V2) 任务运行中 Pimu 重启 | 启动时把 `runs.status='running'` 标为 `failed`（`error='pimu restarted'`），若 `attempt < max_retries` 入队重试 |

### 3.5 资源预算（2C3G）
- Go 进程目标 < 50MB RSS。
- 每个 pi（Node）进程 **【不确定】约 150–400MB**，故 `PIMU_MAX_PROCS=3`；超限时 POST 返回 429，UI 提示“释放一个会话”。V2 任务与聊天共享该上限。
- 模型列表：启动一个 `pi --mode rpc --no-session` 临时进程执行 `get_available_models` 后关闭，结果缓存 10 分钟（不占锁）。

---

## 4. 后端

### 4.1 目录结构

```
pimu/
├─ cmd/pimu/main.go            # 子命令：serve | release <id> | version
├─ internal/
│  ├─ config/config.go         # 读 env，校验，单个 Config struct
│  ├─ pirpc/                   # pi RPC 客户端：spawn、JSONL 读写、请求关联
│  │   ├─ proc.go
│  │   └─ proc_test.go         # 用 testdata/fakepi 脚本
│  ├─ lock/lock.go             # §3.3A
│  ├─ sessions/                # 只读扫描/解析 JSONL：列表、消息
│  ├─ hub/hub.go               # Proc 表、事件 ring buffer、reaper、并发上限
│  ├─ httpapi/                 # handlers、auth、sse
│  ├─ store/  (V2)             # SQLite 打开、迁移、查询（手写 SQL）
│  ├─ tasks/  (V2)             # cron 调度 + runner
│  └─ notify/ (V2)             # telegram
├─ web/                        # Vite 项目；dist/ 被 embed
│  └─ embed.go                 # //go:embed all:dist
├─ extensions/pimu-guard.ts
├─ testdata/fakepi             # 假 pi（shell/Go），按脚本输出事件，测试不需要 API key
├─ deploy/pimu.service
├─ Makefile                    # make web / build / test / install-guard
└─ DESIGN.md
```

### 4.2 配置（全部 env，无配置文件）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PIMU_ADDR` | `127.0.0.1:7777` | 监听地址；非 loopback 时启动打印警告 |
| `PIMU_TOKEN` | 必填，≥32 字符 | 登录口令 + cookie HMAC 密钥 |
| `PIMU_PUBLIC_URL` | 空 | 如 `https://pimu.example.com`；用于 Origin 校验、cookie `Secure`、通知链接 |
| `PIMU_PI_BIN` | `pi` | systemd 下建议绝对路径 |
| `PIMU_PI_ARGS` | 空 | 追加给 pi 的参数，空格分隔 |
| `PIMU_WORKDIRS` | `$HOME` | 允许作为 cwd 的目录（逗号分隔，含子目录） |
| `PIMU_IDLE_TIMEOUT` | `10m` | 空闲回收 |
| `PIMU_MAX_PROCS` | `3` | 并发 pi 进程上限 |
| `PIMU_DATA_DIR` | `~/.local/share/pimu` | V2 的 `pimu.db` |
| `PIMU_LOG_LEVEL` | `info` | `debug` 时记录 pi stderr |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | 与 pi 一致，透传 |
| `PIMU_TELEGRAM_TOKEN` / `PIMU_TELEGRAM_CHAT_ID` | 空 | V2，空则不通知 |

### 4.3 HTTP API

全部 JSON；错误统一 `{"error":"<code>","message":"<人类可读>"}`。除 `/api/health`、`/api/login`、静态资源外都需鉴权。

**V1**
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | `{"ok":true,"version":"..","pi":"<pi --version>"}` |
| POST | `/api/login` | `{token}` → 设置 cookie；失败 401，5 次/分钟/IP 限流 |
| POST | `/api/logout` | 清 cookie |
| GET | `/api/workdirs` | 可选 cwd 列表 |
| GET | `/api/models` | 可用模型（缓存） |
| GET | `/api/sessions` | 列表：`id,path,cwd,name,preview,updatedAt,status(idle|running|streaming|external)` 按 `updatedAt` 倒序；扫描结果按文件 mtime 缓存 |
| POST | `/api/sessions` | `{cwd, provider?, modelId?, thinking?}` → 启动并返回 `{id}` |
| GET | `/api/sessions/{id}` | 会话元信息 + 运行中则附 `get_state` 结果 |
| GET | `/api/sessions/{id}/messages` | 运行中：`get_messages`；否则只读解析 JSONL（§4.5） |
| GET | `/api/sessions/{id}/events` | SSE（§4.4） |
| POST | `/api/sessions/{id}/prompt` | `{message, images?, behavior?: "steer"|"followUp"}`；未运行则懒启动；被外部占用 409；超并发 429 |
| POST | `/api/sessions/{id}/abort` | 先 `clear_queue` 再 `abort`，返回被清掉的队列文本 |
| POST | `/api/sessions/{id}/model` | `{provider, modelId}` → `set_model` |
| POST | `/api/sessions/{id}/thinking` | `{level}` → `set_thinking_level` |
| POST | `/api/sessions/{id}/name` | `{name}` → `set_session_name` |
| GET | `/api/sessions/{id}/commands` | `get_commands`（输入 `/` 时补全） |
| POST | `/api/sessions/{id}/ui-response` | 转发 `extension_ui_response` `{id, value?|confirmed?|cancelled?}` |
| POST | `/api/sessions/{id}/release` | 关闭进程、释放锁（“交给终端”） |

**V2**
| 方法 | 路径 | 用途 |
|---|---|---|
| GET/POST | `/api/tasks` | 列表 / 新建 |
| GET/PATCH/DELETE | `/api/tasks/{id}` | 详情 / 修改（含 enabled）/ 删除 |
| POST | `/api/tasks/{id}/run` | 立即运行 |
| GET | `/api/runs?task_id=&limit=50` | 运行记录 |
| GET | `/api/events` | 全局 SSE：`run_update`、`proc_state`（首页 Activity 用） |
| GET/PUT | `/api/memory` | 读写 `<agent-dir>/AGENTS.md`（PUT 带 `mtime` 做乐观并发，冲突 409） |

不提供：删除会话、导出、文件浏览（用终端 pi）。

### 4.4 事件流格式（SSE）

```
id: 1842
event: pi
data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hel"}}

id: 1843
event: pimu
data: {"type":"proc_state","state":"ready"}

: ping
```

- `event: pi`：pi stdout 的事件行**原样转发**（不改字段、不重命名）——“薄层”原则。包括 `extension_ui_request`、`extension_error`。命令响应不转发。
- `event: pimu`：Pimu 自有事件，仅以下几种：
  - `{"type":"proc_state","state":"starting|ready|exited","code"?,"stderrTail"?}`
  - `{"type":"lock","holder":"pimu|external|none"}`
  - `{"type":"resync"}`：客户端 `Last-Event-ID` 超出缓冲，需重新 GET messages
  - （V2 全局流）`{"type":"run_update","run":{...}}`
- `id` 为每会话单调递增 seq；每会话 ring buffer 保留最近 5000 条（仅内存）。
- 每 15s 发 `: ping`（Cloudflare 空闲超时约 100s）。响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。
- 前端重建流式消息：`message_start` 建草稿 → `message_update` 按 `contentIndex` 追加 `text_delta/thinking_delta/toolcall_delta` → `message_end` 用权威 message 替换草稿；工具状态按 `toolCallId` 由 `tool_execution_start/update/end` 更新；`agent_settled` 结束“运行中”状态。

### 4.5 只读解析会话 JSONL（`internal/sessions`）

- 列表：`<agent-dir>/sessions/*/*.jsonl`（或 `PI_CODING_AGENT_SESSION_DIR`）。读首行 header（`id,cwd,timestamp`），扫描最后一个 `session_info.name`、第一条 `role:user` 文本（截 80 字）作 preview。按 mtime 缓存。
- 消息：取文件最后一个带 `id` 的条目为 leaf，沿 `parentId` 回溯到根得到当前分支，输出其中 `type:"message"` 且 role ∈ {user, assistant, toolResult} 的条目。**【不确定】** “最后一行即 leaf”在 `/tree` 跳转后可能不成立；运行中一律以 `get_messages` 为准。
- 单行上限 16MB；解析失败的行跳过并记 warn。
- 绝不写、不改名、不删除会话文件。

### 4.6 鉴权与安全

- 登录：`POST /api/login {token}`，`subtle.ConstantTimeCompare`。成功设 cookie `pimu=<expiry>.<HMAC-SHA256(PIMU_TOKEN, expiry)>`，`HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`，`Secure`（PUBLIC_URL 为 https 时）。也接受 `Authorization: Bearer <PIMU_TOKEN>`（curl/脚本用）。
- CSRF：SameSite=Strict + 所有 POST/PATCH/PUT/DELETE 要求 `Content-Type: application/json` + 若设置了 `PUBLIC_URL` 则校验 `Origin`。
- Cloudflare：`cloudflared` 隧道指向 `http://127.0.0.1:7777`；Access 应用策略仅允许本人邮箱（OTP），会话时长设 1 个月（减少 iOS PWA 反复登录）。Pimu 不校验 `Cf-Access-Jwt-Assertion`（需 JWKS/JWT 依赖，YAGNI；靠只监听 loopback 保证流量只能来自隧道）。
- `PIMU_WORKDIRS` 校验所有 cwd（`filepath.Clean` + 前缀判断 + `EvalSymlinks`）。
- 不暴露任何读写任意文件的 API。pi 本身拥有该 OS 用户全部权限（官方 security.md），建议跑在专用用户/VPS 上。
- 项目信任：RPC 无法弹出信任提示；未决时按 `defaultProjectTrust` 处理。需要加载项目 `.pi/` 时在 `PIMU_PI_ARGS` 加 `--approve`（自担风险）。

### 4.7 日志
- `slog` JSON 到 stdout（journald 收集）。字段：`ts level msg session pid req_id dur_ms`。
- 不记录 prompt/回复正文、token、cookie。pi stderr 仅 debug 级别记录。

---

## 5. 数据库（V2 引入）

文件 `$PIMU_DATA_DIR/pimu.db`。打开时执行：`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`。`db.SetMaxOpenConns(1)`（单写者，最简单）。迁移：`PRAGMA user_version` + 代码里一个 `[]string` 顺序执行，无迁移框架。

```sql
-- user_version = 1
CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  prompt       TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  schedule     TEXT,                         -- cron 表达式(5 段)；NULL = 仅手动
  model        TEXT,                         -- "provider/modelId"；NULL = pi 默认
  session_mode TEXT    NOT NULL DEFAULT 'new' CHECK (session_mode IN ('new','reuse')),
  session_id   TEXT,                         -- reuse 时固定续写的 pi 会话 id
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
  session_id   TEXT,                         -- 指向 pi 会话，可在 Chat 打开
  summary      TEXT,                         -- get_last_assistant_text，截 2000 字
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX runs_task_created ON runs(task_id, created_at DESC);
CREATE INDEX runs_status ON runs(status) WHERE status IN ('queued','running');
```

就这两张表。会话、消息、活动、记忆都不进库。时间一律 UTC ISO8601 存储，前端用 `Intl.DateTimeFormat` 按浏览器时区显示。

**任务执行（V2）**：取并发槽 → `session_mode=new` 时 `--session-id pimu-t<task>-r<run>`，`reuse` 时 `--session <session_id>`（被占用则 run 记 `failed: session busy`）→ `set_model`（如有）→ `prompt` → 等 `agent_settled`（超时则 `abort`，记 `failed: timeout`）→ `get_last_assistant_text` 写 summary → 最后一条 assistant `stopReason=="error"` 或 `settled.aborted` → failed → 按 notify 发 Telegram → 关闭进程。失败且 `attempt < max_retries` → 1 分钟后 `trigger='retry'` 重跑。停机期间错过的 cron **不补跑**。

---

## 6. 前端

### 6.1 页面 / 路由（hash）

| 路由 | 页面 | 版本 |
|---|---|---|
| `#/login` | 输入 token | V1 |
| `#/` | 会话列表（按 cwd 分组折叠，搜索框过滤 name/preview） | V1 |
| `#/s/{id}` | Chat；顶部 Tabs：`对话 | 活动` | V1 |
| `#/new` | 新会话：选 cwd、模型（可选）→ 跳转 Chat | V1（可做成 Dialog） |
| `#/tasks`、`#/tasks/{id}` | 任务列表 / 详情+运行记录 | V2 |
| `#/memory` | 编辑 `AGENTS.md`（Textarea + 保存） | V2 |

布局：<1024px 单栏，底部无 tab bar（页面少，用顶部返回 + 菜单）；≥1024px 左侧 280px 会话侧栏 + 主区，活动面板为右侧 360px 可收起栏。

### 6.2 组件清单（只用 shadcn 现成组件，`npx shadcn@latest add ...`）

`button` `input` `textarea` `label` `badge` `separator` `skeleton` `tabs` `collapsible` `dialog` `alert-dialog` `sheet` `dropdown-menu` `select` `tooltip`（仅桌面）`sonner` `switch`（V2）`card`（V2 任务）。
不用：`scroll-area`（iOS 用原生滚动更顺）、`command`（避免 cmdk）、`form`（避免 zod/rhf）、`sidebar`（过重，自己用 flex 布局）。

自写的业务组件（组合以上原子，每个 < 200 行）：`SessionList`、`ChatView`、`MessageItem`、`ToolCallRow`、`ThinkingBlock`、`Composer`、`ModelPicker`、`ActivityList`、`ExtensionDialog`、`ConnectionBanner`。

### 6.3 状态管理

- 一个 `SessionStore`：`useReducer(reducer, init)`，state = `{ messages, draft(流式中的 assistant), tools: Record<toolCallId, ToolState>, streaming, queue, procState, lock, lastEventId, uiRequests[] }`。reducer 直接消费 §4.4 的事件。
- 一个 `useSessionEvents(id)` hook：管理 `EventSource`、`visibilitychange` 时重连、收到 `resync` 时重新拉 messages。
- delta 合并：事件进入数组缓冲，`requestAnimationFrame` 每帧 dispatch 一次批量（防止每 token 重渲）。
- API 封装：一个 `api.ts`，`fetch` + 统一错误；401 跳 `#/login`。
- 全局只有 `AuthContext`（是否已登录）。其余状态留在页面内。不做离线缓存。

### 6.4 UI/UX 约束（硬规则）

**移动端 / iPhone**
- 设计基准宽 375px，最小 320px 不出现横向滚动（代码块与表格自身横向滚动）。
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`；顶栏 `padding-top: env(safe-area-inset-top)`，Composer `padding-bottom: max(env(safe-area-inset-bottom), 8px)`。
- 高度用 `100dvh`，不用 `100vh`。Composer 固定底部，消息区独立滚动。
- 所有输入框 `font-size ≥ 16px`（防 iOS 自动放大）。触控目标 ≥ 44×44px。
- 移动端 Enter = 换行，发送按钮发送；桌面 Enter 发送、Shift+Enter 换行（按 `(pointer: coarse)` 判断）。
- 回到前台（`visibilitychange`）立即重连 SSE 并拉一次 state。

**PWA**
- `manifest.webmanifest`：`name: "Pimu"`, `display: "standalone"`, `start_url: "/"`, `theme_color`/`background_color` 与暗色背景一致，图标 192/512（含 maskable）+ `apple-touch-icon` 180。
- `apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style: black-translucent`。
- Service Worker 只缓存构建产物（app shell），**永不缓存 `/api/*`**；新版本 `skipWaiting` 后提示刷新（sonner toast）。手写 ~40 行，不引 workbox/vite-plugin-pwa。

**主题与密度**
- 默认跟随 `prefers-color-scheme`，暗色为一等公民；只用 shadcn 的 CSS 变量（`neutral` base color），不自定义调色板。
- 正文 15px/行高 1.6；元信息 12–13px `text-muted-foreground`；代码/工具 `font-mono text-[13px]`。
- 用户消息：右对齐浅底气泡；assistant：全宽无气泡（信息密度优先）。消息间距 12px。

**流式渲染**
- 草稿消息末尾显示闪烁光标；Markdown 在流式中每帧重渲（未闭合代码块按纯文本显示可接受）。
- 自动滚动仅当用户距底部 < 80px；否则显示“↓ 新消息”浮动按钮。
- 顶部状态行：`运行中 · 模型名 · 已用 xx s`；`agent_settled` 后消失。

**工具调用与思考**
- 每个工具调用一行 `ToolCallRow`（Collapsible）：图标 + 工具名 + 一行摘要（bash 取 command，read/edit/write 取 path，其它取首个字符串参数，截 60 字）+ 状态（Spinner / ✓ / ✗）+ 耗时 `durationMs`。
- 默认折叠；**出错默认展开**。展开显示参数 JSON 与结果，结果超 200 行截断并给“显示全部”。图片结果（截图）显示缩略图，点开 Dialog 看大图。
- thinking 块默认折叠，标题“思考 · N 字”。
- 连续 ≥3 个工具调用合并为“N 个操作”组，可展开（减少手机滚动）。

**活动（Muse 式）**
- 按时间倒序列出本会话的工具执行：时间、工具、摘要、状态、耗时；点击跳到对话中对应位置。数据完全来自 messages + 事件，不额外存储。
- V2 首页顶部显示“正在进行”：运行中的会话/任务各一行（类比 Muse 头像下的当前动作）。

**扩展交互**
- `extension_ui_request` 的 `confirm` → AlertDialog；`select` → 按钮列表 Dialog；`input/editor` → Dialog + Textarea；有 `timeout` 时显示倒计时。`notify` → sonner；`setStatus/setWidget/setTitle` V1 忽略。

**空态 / 错误态**
- 无会话：一句说明 + “新建会话”按钮。无模型：提示“在终端运行 `pi` 并 `/login`”。
- SSE 断开：顶部细 banner “重新连接中…”，恢复后自动消失；不弹 toast 轰炸。
- 进程退出：消息流内插入错误卡片（退出码 + stderr 尾部 + “重试”）。
- 被终端占用：只读 + banner；409/429 都给出可执行的下一步文字。
- 加载用 Skeleton，不用全屏 spinner。

**可访问性**
- 全部交互可键盘到达；Dialog 焦点陷阱用 shadcn/Radix 自带。
- 图标按钮必须有 `aria-label`；状态行 `aria-live="polite"`，**流式文本区不设 aria-live**。
- 对比度 ≥ 4.5:1（shadcn 默认满足，不改色）；尊重 `prefers-reduced-motion`（关闭光标闪烁与过渡）。

**文案**：中文界面，术语（session、model、tool 名）保留原文；不做 i18n 框架。

---

## 7. 代码与工程约束

- Go：`gofmt` + `go vet`；包名单词小写；错误 `fmt.Errorf("...: %w", err)`；不用 panic 处理业务错误；context 贯穿请求与子进程；每个文件 < 400 行。
- 不写接口抽象“以备将来”：只有一个实现就不定义 interface（测试用 fakepi 可执行文件替代 mock）。
- TS：`strict: true`；不用 `any`（pi 事件用手写的最小 discriminated union，未知字段保留为 `unknown`）；函数组件 + hooks；文件 < 300 行。
- 前端产物 gzip 后 JS < 250KB。
- Commit：Conventional Commits。
- 测试：Go 单测覆盖 `pirpc`（含 U+2028 不切行、超长行、请求关联、进程退出）、`lock`（陈旧锁）、`sessions`（解析 fixture）。前端只做 `tsc --noEmit` + `vite build`，不引测试框架（V1）。

### 部署（systemd 用户服务样例 `deploy/pimu.service`）

```ini
[Unit]
Description=Pimu - Just Pi, everywhere
After=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/pimu serve
EnvironmentFile=%h/.config/pimu/env
Environment=PATH=%h/.local/bin:%h/.local/share/pi/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=20
MemoryMax=2500M

[Install]
WantedBy=default.target
```

> 现行部署见 [DEPLOY.md](DEPLOY.md)（system unit + `pimu` 用户）；下面是早期的 user unit 方案。

安装：`install -m755 bin/pimu ~/.local/bin/ && systemctl --user daemon-reload && systemctl --user enable --now pimu && loginctl enable-linger $USER`（linger 让用户服务开机即跑）。**【不确定】** pi 官方安装脚本把 `pi`/Node 放在哪个路径，`PATH` 需按实际 `which pi` 调整，或直接设 `PIMU_PI_BIN` 绝对路径。

`~/.config/pimu/env`（`chmod 600`）：
```
PIMU_TOKEN=<openssl rand -hex 32>
PIMU_PUBLIC_URL=https://pimu.example.com
PIMU_WORKDIRS=/home/me/projects,/home/me/notes
```

cloudflared：`cloudflared tunnel create pimu`，ingress `hostname: pimu.example.com → service: http://127.0.0.1:7777`，Zero Trust 中为该 hostname 建 Access 应用（Allow: 本人邮箱）。

---

## 8. 版本范围与验收

### V1 · Chat + RPC（精确范围）
包含：§4.3 V1 全部 API；会话列表/新建/续写/只读浏览；流式聊天（text/thinking/tool）；steer/followUp/abort；模型与 thinking 切换；`/` 命令补全；扩展 dialog；会话 Activity tab；锁 + 守卫扩展 + `pimu release`；空闲回收；PWA 可安装；systemd + cloudflared 文档。
不包含：SQLite、任务、Telegram、记忆页、Browser、图片上传（V1.1 再加，协议已支持 `images`）。

**验收（全部可执行）**
```bash
# 构建
make build                                   # = (cd web && npm ci && npm run build) && go build -o bin/pimu ./cmd/pimu
go vet ./... && go test ./...                # 全绿；测试不依赖网络与 API key（用 testdata/fakepi）
(cd web && npx tsc --noEmit)                 # 无错误
./bin/pimu version                           # 打印版本
ls -la bin/pimu                              # 单文件，无需 web/ 目录即可运行

# 启动
export PIMU_TOKEN=$(openssl rand -hex 32)
./bin/pimu serve &
curl -s localhost:7777/api/health            # {"ok":true,...,"pi":"1.4.0"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:7777/api/sessions   # 401
A="Authorization: Bearer $PIMU_TOKEN"

# 新会话 + 流式
ID=$(curl -s -H "$A" -H 'Content-Type: application/json' -d '{"cwd":"'$HOME'"}' localhost:7777/api/sessions | jq -r .id)
curl -sN -H "$A" localhost:7777/api/sessions/$ID/events > /tmp/ev.txt &
curl -s -H "$A" -H 'Content-Type: application/json' -d '{"message":"只回复 pong"}' localhost:7777/api/sessions/$ID/prompt
sleep 20; grep -c text_delta /tmp/ev.txt     # > 0
grep -q agent_settled /tmp/ev.txt && echo OK
ls ~/.pi/agent/sessions/*/*_$ID.jsonl        # 会话文件由 pi 创建
ls ~/.pi/agent/locks/$ID.lock                # Pimu 持锁

# 并发写防护
make install-guard                           # 复制 extensions/pimu-guard.ts 到 ~/.pi/agent/extensions/
pi --session $ID                             # 应提示被 Pimu 占用并退出，会话文件行数不增加 message 条目
./bin/pimu release $ID && test ! -e ~/.pi/agent/locks/$ID.lock && echo released
# 另开终端运行 pi --session $ID 保持打开，然后：
curl -s -o /dev/null -w '%{http_code}\n' -H "$A" -H 'Content-Type: application/json' -d '{"message":"x"}' localhost:7777/api/sessions/$ID/prompt   # 409

# 崩溃恢复
pkill -9 -f "pi --mode rpc"                  # SSE 中出现 event: pimu / proc_exit；锁被释放
kill -9 %1; ./bin/pimu serve &               # 重启后旧锁被判陈旧，可再次 prompt

# 资源
ps -o rss= -p $(pgrep -f 'pimu serve')       # < 51200 (KB)
```
手工验收（iPhone Safari）：添加到主屏幕后全屏打开；刘海/底部横条不遮挡内容；输入框聚焦不放大；锁屏 1 分钟后回来自动续上流；工具调用默认折叠、错误展开；暗色正常。

### V2 · Tasks + Memory + Telegram
`tasks/runs` 两表 + cron 调度 + 手动运行 + 重试；任务结果可在 Chat 中打开对应 pi 会话；Telegram 出站通知（标题、状态、summary 前 500 字、`PIMU_PUBLIC_URL/#/s/<id>` 链接）；记忆页编辑 `<agent-dir>/AGENTS.md`；首页“正在进行”与全局 SSE。

### V3 · Browser
`pi mcp add playwright -- npx -y @playwright/mcp@latest --headless --isolated` 写入 pi 用户级 `mcp.json`（Pimu 不管理浏览器进程）；Pimu 只做：工具结果中的截图缩略图/大图、按会话的“浏览器操作”过滤视图。同一时刻最多 1 个浏览器（靠 `PIMU_MAX_PROCS` 与 prompt 约束）。**【不确定】** `@playwright/mcp` 当前版本 0.0.83 的截图是否以 image content 返回、以及 2C3G 上 headless Chromium 的内存（估 300–500MB）。

---

## 9. 风险与「不确定」清单

1. **【不确定】pi 进程内存**：每个 Node pi 进程 RSS 未实测；`PIMU_MAX_PROCS=3` 是估计值。V1 第一件事：`pi --mode rpc` 空闲与一轮对话后 RSS 实测。
2. **【不确定】守卫扩展 API**：`ctx.shutdown()`、`session_before_switch` 取消返回值、`ctx.sessionManager.getSessionId()` 依据 docs/extensions.md（1.4.0），需在真机验证扩展在 `session_start` 阶段调用 `shutdown()` 是否可行。
3. **锁的固有缺口**：pi 在扩展钩子前可能已写入 `model_change` 等元数据条目（#8300）；终端用户不装守卫扩展时完全无防护。只能文档提醒。
4. **【不确定】只读解析的 leaf 判定**：“最后一个条目即 leaf”在 `/tree` 跳转后可能不成立；也可考虑用 `get_entries` 的 `leafId`，但那需要启动 pi 进程（会占锁）。
5. **【不确定】新会话文件何时落盘**：`--session-id` 新建后，pi 可能在首条消息后才写文件；列表接口需同时合并 Hub 中运行但尚无文件的会话。
6. **协议漂移**：pi 发布频繁（1.4.0 于 2026-10-22），事件可能增字段。对策：原样转发、前端忽略未知事件、`/api/health` 显示 pi 版本，README 写明已验证版本。
7. **项目信任**：RPC 不能弹信任提示；默认会跳过项目 `.pi/` 资源，用户可能困惑“为什么项目 skills 没加载”。
8. **【不确定】Cloudflare Access + iOS 独立模式 PWA**：Access 登录跳转在 standalone 模式下可能跳出到 Safari；需实测，必要时延长 Access 会话或改用 Access service token 之外的方式。
9. **SSE 与 iOS 后台**：iOS 后台会断开连接，后台期间无法收到实时事件——这正是 V2 用 Telegram 的原因。
10. **定位重叠**：`agegr/pi-web`（★7911）已覆盖大部分 V1 Chat 功能。Pimu 的价值在常驻 + 任务 + 通知 + 移动优先；如果 V2 不做，Pimu 意义不大。
11. **【不确定】“Muse” 所指**：按 Meta Muse 个人 Agent（muse.ai）的“活动日志 + 后台任务 + 有意义才通知”理解；若用户指的是别的项目，需确认。
12. **安全**：pi 以该 OS 用户全部权限执行命令；Pimu 暴露到公网后，token 泄露 = 远程代码执行。必须 Cloudflare Access + 长随机 token + loopback 监听三者同时满足。
