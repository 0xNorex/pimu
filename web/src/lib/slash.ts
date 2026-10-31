// pi's built-in slash commands only work in its TUI; over RPC they reach the
// model as plain text (docs/SLASH.md). The composer intercepts these and maps
// them to RPC calls or Pimu screens; anything else (extension commands,
// /skill:*, prompt templates) passes through to pi unchanged.
export const BUILTINS: [string, string][] = [
  ['compact', '压缩上下文，可附加指示'],
  ['model', '切换模型（/model 提供方/模型 或打开选择器）'],
  ['thinking', '思考强度（off/minimal/low/medium/high/xhigh）'],
  ['name', '重命名会话 / Bot'],
  ['session', '会话统计：消息、token、费用、上下文'],
  ['export', '导出为 HTML'],
  ['copy', '复制最后一条回复'],
  ['new', '新话题（清空上下文，之前的对话进「历史」）'],
  ['resume', '回到 Bot 列表'],
  ['settings', '打开设置'],
  ['reload', '重启这个会话的 pi 进程'],
  ['fork', '分叉（请在终端用 pi）'],
  ['clone', '复制会话（请在终端用 pi）'],
]
const NAMES = new Set(BUILTINS.map(([n]) => n))

// parseBuiltin returns [name, arg] when text is a built-in command.
export function parseBuiltin(text: string): [string, string] | null {
  const m = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  return m && NAMES.has(m[1]) ? [m[1], (m[2] ?? '').trim()] : null
}
