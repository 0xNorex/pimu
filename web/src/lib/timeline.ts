import type { ToolView } from '@/components/ToolCallRow'
import type { ToolState } from './store'
import type { AssistantMessage, ImageBlock, Message, ToolResultMessage } from './types'

export type Item =
  | { kind: 'user'; key: string; text: string; images: ImageBlock[] }
  | { kind: 'text'; key: string; text: string; live: boolean }
  | { kind: 'thinking'; key: string; text: string; live: boolean }
  | { kind: 'tool'; key: string; tool: ToolView; ts: number }
  | { kind: 'group'; key: string; tools: ToolView[] }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'aborted'; key: string }

// Flattens messages (+ streaming draft) into render items.
function flatten(messages: Message[], draft: AssistantMessage | null, tools: Record<string, ToolState>, streaming: boolean): Item[] {
  const results = new Map<string, ToolResultMessage>()
  for (const m of messages) if (m.role === 'toolResult') results.set(m.toolCallId, m)

  const flat: Item[] = []
  const all = draft ? [...messages, draft] : messages
  all.forEach((m, mi) => {
    const k = `${mi}-${m.timestamp}`
    if (m.role === 'user') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content
      flat.push({
        kind: 'user',
        key: k,
        text: blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''),
        images: blocks.filter((b): b is ImageBlock => b.type === 'image'),
      })
      return
    }
    if (m.role !== 'assistant') return
    const live = m === draft
    m.content.forEach((b, bi) => {
      const key = `${k}-${bi}`
      if (b.type === 'text' && (b.text || live)) flat.push({ kind: 'text', key, text: b.text, live })
      else if (b.type === 'thinking' && b.thinking) flat.push({ kind: 'thinking', key, text: b.thinking, live: live && bi === m.content.length - 1 })
      else if (b.type === 'toolCall') {
        const r = results.get(b.id)
        const t = tools[b.id]
        const status: ToolView['status'] = r ? (r.isError ? 'error' : 'ok') : t ? (t.status === 'running' && !streaming ? 'pending' : t.status) : streaming ? 'running' : 'pending'
        flat.push({
          kind: 'tool',
          key,
          ts: m.timestamp,
          tool: { call: b, status, content: r?.content ?? t?.result?.content, details: r?.details ?? t?.result?.details, durationMs: t?.durationMs },
        })
      }
    })
    if (m.stopReason === 'error' && m.errorMessage) flat.push({ kind: 'error', key: `${k}-err`, text: m.errorMessage })
    if (m.stopReason === 'aborted') flat.push({ kind: 'aborted', key: `${k}-abort` })
  })
  return flat
}

// Render items; ≥3 consecutive tool calls become one group.
export function buildItems(messages: Message[], draft: AssistantMessage | null, tools: Record<string, ToolState>, streaming: boolean): Item[] {
  const flat = flatten(messages, draft, tools, streaming)
  const out: Item[] = []
  for (let i = 0; i < flat.length; ) {
    let j = i
    while (j < flat.length && flat[j].kind === 'tool') j++
    if (j - i >= 3) {
      const run = flat.slice(i, j) as Extract<Item, { kind: 'tool' }>[]
      out.push({ kind: 'group', key: run[0].key + '-g', tools: run.map((t) => t.tool) })
      i = j
    } else {
      out.push(flat[i])
      i++
    }
  }
  return out
}

// Tool activity for the Activity tab, newest first.
export function toolActivity(messages: Message[], draft: AssistantMessage | null, tools: Record<string, ToolState>, streaming: boolean) {
  return flatten(messages, draft, tools, streaming)
    .flatMap((it) => (it.kind === "tool" ? [{ tool: it.tool, ts: it.ts }] : []))
    .reverse()
}
