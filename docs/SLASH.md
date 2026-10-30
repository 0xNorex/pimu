# 斜杠命令对照（pi 1.4.0）

结论：**不一致**。pi 的 25 个内置命令只在交互式 TUI 里处理；`--mode rpc` 的 `prompt` 只展开扩展命令、`/skill:*` 和提示模板。
实测把 `/session` 当 prompt 发给 RPC，它被当成普通文本交给模型，模型还自己跑了 `ls`。
`/mcp`（扩展命令）则正常执行，并通过 `extension_ui_request notify` 返回结果。
因此 Pimu 的输入框必须**在客户端拦截内置命令**，改调对应的 RPC 或 Pimu 界面，不能直接透传。

来源：`docs/slash-commands.md`、`docs/rpc-commands.md`（get_commands：“Built-in TUI commands are not included”），以及 `dist` 中内置命令注册表（共 24 项；`/llama` 由 builtin:llama.cpp 提供）。

| 命令 | CLI | RPC | Pimu 现在 | 计划 |
|---|---|---|---|---|
| `/model [p/m]` | ✓ | `set_model` / `cycle_model` | 模型选择器 ✓ | 拦截 → RPC |
| `/thinking [lvl]` | ✓ | `set_thinking_level` | 选择器 ✓ | 拦截 → RPC |
| `/compact [指令]` | ✓ | `compact` | ✗ | **拦截 → RPC（P1）** |
| `/session` | ✓ | `get_session_stats` | ✗ | 拦截 → RPC，显示统计卡片（顺带做每个 bot 的用量） |
| `/name [名]` | ✓ | `set_session_name` | 重命名 ✓ | 拦截 → RPC |
| `/fork` | ✓ | `fork` + `get_fork_messages` | ✗ | RPC：消息菜单“从这里分叉”→ 新 bot |
| `/clone` | ✓ | `clone` | ✗ | RPC：“复制 bot” |
| `/export [path]` | ✓ | `export_html` | ✗ | RPC：生成后下载 |
| `/copy` | ✓ | `get_last_assistant_text` | ✗ | Pimu 界面：消息复制按钮 |
| `/tree` | ✓ | 只有 `get_tree`，没有导航命令 | ✗ | P3：只读树视图，用 fork 代替导航 |
| `/new` | ✓ | `new_session` | 新建 bot ✓ | Pimu 界面（新会话 = 新 bot） |
| `/resume` | ✓ | `switch_session` | bot 列表 ✓ | Pimu 界面 |
| `/import <path>` | ✓ | ✗（`switch_session` 接收路径） | 终端会话 → 设为 Bot ✓ | Pimu 界面 |
| `/reload` | ✓ | ✗ | 释放后重新拉起进程 ≈ | Pimu 界面：“重载”= 重启 bot 进程 |
| `/settings` | ✓ | ✗ | 设置页 ✓ | Pimu 界面 |
| `/scoped-models` | ✓ | ✗（settings `enabledModels`） | ✗ | Pimu 界面（设置页，低优先） |
| `/login` `/logout` | ✓ | ✗ | ✗ | 不需要（用 models.json 里的 key；OAuth 去终端执行 `pi`） |
| `/trust` | ✓ | ✗ | ✗ | 不需要（P3 视情况而定） |
| `/hotkeys` | ✓ | ✗ | ⌘K ✓ | 不需要 |
| `/changelog` | ✓ | ✗ | 设置页显示版本 | 不需要 |
| `/share` `/bug` | ✓ | ✗ | ✗ | 不需要（会上传会话，有隐私风险） |
| `/quit` | ✓ | ✗ | 释放 ✓ | 不需要 |
| `/mcp` `/llama`（扩展） | ✓ | `prompt` 透传 ✓（实测） | 自动补全 ✓ | 原生透传 |
| `/skill:名`、`/模板` | ✓ | `prompt` 展开 ✓（文档） | 自动补全 ✓ | 原生透传 |

实现要点：
- 前端维护一个内置命令表。输入框命中时调用对应的 API，不命中才透传。
- 自动补全把内置命令和 `get_commands` 合并显示，并标注来源。
- 后端补齐透传路由：`compact`、`get_session_stats`、`fork`、`clone`、`export_html`、`get_last_assistant_text`，复用现有的 `passthrough()`。

## 导入主机会话（实测 2026-10-30）

1. 在终端执行 `pi -p "请记住暗号：蓝鲸-42…"`，生成会话 `01a18bf6…`。
2. 这个会话出现在 Pimu 的 `GET /api/sessions` 里，即“终端会话”。
3. 调用 `POST /api/bots {sessionId}` 把它设为 Bot，再在 Pimu 里问“暗号是什么”，回答 **蓝鲸-42**。
4. 在 Pimu 里释放这个 bot 后，回到终端执行 `pi -p --session <id>`，模型答出“2 蓝鲸-42”。
5. 会话文件始终是同一个 jsonl，往返续写都没有问题。

注意：Pimu 运行这个会话时，`pimu-guard` 会阻止终端 pi 同时写入，所以必须先在 Pimu 里释放。
