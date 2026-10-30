// Settings sections; kept apart so the lazy Settings chunk is not pulled into the shell.
export const SECTIONS = [
  ['models', '模型'],
  ['extensions', '扩展'],
  ['skills', 'Skills'],
  ['mcp', 'MCP'],
  ['memory', '记忆'],
  ['goals', '主动'],
  ['pimu', 'Pimu'],
] as const
export type Section = (typeof SECTIONS)[number][0]
