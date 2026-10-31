import type { ToolView } from '@/components/ToolCallRow'
import type { Item } from './timeline'

// Progressive disclosure for the agent's "work" (thinking + tool calls).
// The chat shows only what it said; the work is one tap away per reply, or
// always on with the 显示过程 preference (off / summary / full).
export type Work = 'off' | 'summary' | 'full'
export type Entry =
  | { kind: 'item'; item: Item }
  | { kind: 'foot'; key: string; turn: string; tools: number; thinking: number; open: boolean; text: string; summary: boolean }
  | { kind: 'status'; key: string; text: string }

const isWork = (it: Item) => it.kind === 'thinking' || it.kind === 'tool' || it.kind === 'group'

// One plain phrase for what a tool is doing, from its name.
export function toolPhrase(name: string): string {
  const n = name.toLowerCase()
  if (/search|google|bing|serp/.test(n)) return '正在搜索…'
  if (/browser|navigate|fetch|http|url|web|page|screenshot/.test(n)) return '正在浏览网页…'
  if (/bash|shell|exec|command|run|terminal/.test(n)) return '正在运行命令…'
  if (/edit|write|patch|apply|create|replace/.test(n)) return '正在修改文件…'
  if (/read|cat|view|open/.test(n)) return '正在阅读文件…'
  if (/grep|find|glob|ls|list/.test(n)) return '正在查找…'
  if (/pimu_task|task|delegate/.test(n)) return '正在安排后台任务…'
  if (/code|script/.test(n)) return '正在处理…'
  return '正在处理…'
}

function liveStatus(turn: Item[]): string {
  for (let i = turn.length - 1; i >= 0; i--) {
    const it = turn[i]
    if (it.kind === 'text') return it.text.trim() ? '' : '正在思考…'
    if (it.kind === 'thinking') return '正在思考…'
    if (it.kind === 'tool') return toolPhrase(it.tool.call.name)
    if (it.kind === 'group') {
      const t: ToolView | undefined = it.tools.find((x) => x.status === 'running') ?? it.tools[it.tools.length - 1]
      return t ? toolPhrase(t.call.name) : '正在处理…'
    }
  }
  return '正在思考…'
}

const plainText = (turn: Item[]) =>
  turn
    .filter((it): it is Extract<Item, { kind: 'text' }> => it.kind === 'text')
    .map((it) => it.text)
    .join('\n\n')
    .trim()

// shape turns the timeline into what the chat renders for a given mode.
// `open` holds the turns whose work the user revealed.
export function shape(items: Item[], work: Work, open: Set<string>, streaming: boolean): Entry[] {
  const out: Entry[] = []
  let turn: Item[] = []
  const flush = (last: boolean) => {
    if (!turn.length) return
    const key = turn[0].key
    const shown = work === 'full' || open.has(key)
    let tools = 0
    let thinking = 0
    for (const it of turn) {
      if (it.kind === 'tool') tools++
      else if (it.kind === 'group') tools += it.tools.length
      else if (it.kind === 'thinking') thinking++
    }
    for (const it of turn) if (shown || !isWork(it)) out.push({ kind: 'item', item: it })
    const live = last && streaming
    if (live) {
      const st = work === 'full' ? '' : liveStatus(turn)
      if (st) out.push({ kind: 'status', key: key + '-st', text: st })
    } else out.push({ kind: 'foot', key: key + '-ft', turn: key, tools, thinking, open: shown, text: plainText(turn), summary: work !== 'off' })
    turn = []
  }
  for (const it of items) {
    if (it.kind === 'user' || it.kind === 'compaction' || it.kind === 'notice') {
      flush(false)
      out.push({ kind: 'item', item: it })
    } else turn.push(it)
  }
  if (turn.length) flush(true)
  else if (streaming && items.length && items[items.length - 1].kind !== 'compaction') out.push({ kind: 'status', key: 'st', text: '正在思考…' })
  return out
}
