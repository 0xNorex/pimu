// Settings sections; kept apart so the lazy Settings chunk is not pulled into the shell.
// home is the short top level; the developer pages sit under its collapsed 高级.
export const SECTIONS = [
  ['home', '设置'],
  ['appearance', '外观'],
  ['botmode', 'Bot 模式'],
  ['models', '模型'],
  ['extensions', '扩展'],
  ['skills', 'Skills'],
  ['mcp', 'MCP'],
  ['memory', '记忆'],
  ['goals', '主动目标'],
  ['pimu', '关于'],
] as const
export type Section = (typeof SECTIONS)[number][0]
export const ADVANCED: Section[] = ['models', 'extensions', 'skills', 'mcp', 'memory', 'goals', 'pimu']
