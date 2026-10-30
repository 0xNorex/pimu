import type { AssistantBlock, AssistantMessage, Incoming, Message, ToolResult, UIRequest } from './types'

export type ToolState = {
  status: 'running' | 'ok' | 'error'
  result?: ToolResult
  durationMs?: number
  startedAt: number
}

export type SessionStore = {
  loaded: boolean
  messages: Message[]
  draft: AssistantMessage | null
  tools: Record<string, ToolState>
  streaming: boolean
  runStartedAt: number | null
  queue: { steering: string[]; followUp: string[] }
  procState: 'starting' | 'ready' | 'exited'
  exit: { code: number; stderrTail?: string } | null
  lock: 'pimu' | 'external' | 'none'
  uiRequests: UIRequest[]
}

export type Action =
  | { type: 'load'; messages: Message[]; streaming: boolean }
  | { type: 'events'; events: Incoming[] }
  | { type: 'ui_done'; id: string }
  | { type: 'clear_exit' }

export const initialStore: SessionStore = {
  loaded: false,
  messages: [],
  draft: null,
  tools: {},
  streaming: false,
  runStartedAt: null,
  queue: { steering: [], followUp: [] },
  procState: 'exited',
  exit: null,
  lock: 'none',
  uiRequests: [],
}

const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])

function isChat(m: { role: string }): m is Message {
  return m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
}

// Replace a message already present (same role + timestamp) instead of duplicating it.
function upsert(list: Message[], m: Message): Message[] {
  for (let i = list.length - 1; i >= Math.max(0, list.length - 5); i--) {
    if (list[i].role === m.role && list[i].timestamp === m.timestamp) {
      const next = list.slice()
      next[i] = m
      return next
    }
  }
  return [...list, m]
}

function patchDraft(draft: AssistantMessage | null, fn: (c: AssistantBlock[]) => void): AssistantMessage {
  const d: AssistantMessage = draft ?? { role: 'assistant', content: [], timestamp: Date.now() }
  const content = d.content.slice()
  fn(content)
  return { ...d, content }
}

function apply(s: SessionStore, ev: Incoming): SessionStore {
  if (ev.kind === 'pimu') {
    const e = ev.data
    switch (e.type) {
      case 'proc_state':
        if (e.state !== 'exited') return { ...s, procState: e.state, exit: null }
        return {
          ...s,
          procState: 'exited',
          streaming: false,
          draft: null,
          uiRequests: [],
          exit: e.code !== undefined && e.code !== 0 ? { code: e.code, stderrTail: e.stderrTail } : s.exit,
        }
      case 'lock':
        return { ...s, lock: e.holder }
      default:
        return s
    }
  }
  const e = ev.data
  switch (e.type) {
    case 'agent_start':
      return { ...s, streaming: true, runStartedAt: s.runStartedAt ?? Date.now() }
    case 'agent_settled':
      return { ...s, streaming: false, runStartedAt: null, draft: null }
    case 'message_start':
      if (e.message.role !== 'assistant') return s
      return { ...s, draft: { ...(e.message as AssistantMessage), content: [...(e.message as AssistantMessage).content] } }
    case 'message_end':
      if (!isChat(e.message)) return s
      return { ...s, messages: upsert(s.messages, e.message), draft: e.message.role === 'assistant' ? null : s.draft }
    case 'message_update': {
      const a = e.assistantMessageEvent
      const draft = patchDraft(s.draft, (c) => {
        const i = a.contentIndex
        const cur = c[i]
        switch (a.type) {
          case 'text_start':
            c[i] = { type: 'text', text: '' }
            break
          case 'thinking_start':
            c[i] = { type: 'thinking', thinking: '' }
            break
          case 'text_delta':
            c[i] = { type: 'text', text: (cur?.type === 'text' ? cur.text : '') + a.delta }
            break
          case 'thinking_delta':
            c[i] = { type: 'thinking', thinking: (cur?.type === 'thinking' ? cur.thinking : '') + a.delta }
            break
          case 'text_end':
            c[i] = { type: 'text', text: a.content }
            break
          case 'thinking_end':
            c[i] = { type: 'thinking', thinking: a.content }
            break
          case 'toolcall_start':
            c[i] = { type: 'toolCall', id: a.id, name: a.toolName, arguments: {} }
            break
          case 'toolcall_end':
            c[i] = a.toolCall
            break
        }
      })
      return { ...s, draft }
    }
    case 'tool_execution_start':
      return { ...s, tools: { ...s.tools, [e.toolCallId]: { status: 'running', startedAt: Date.now() } } }
    case 'tool_execution_update': {
      const t = s.tools[e.toolCallId] ?? { status: 'running', startedAt: Date.now() }
      return { ...s, tools: { ...s.tools, [e.toolCallId]: { ...t, result: e.partialResult } } }
    }
    case 'tool_execution_end': {
      const t = s.tools[e.toolCallId] ?? { startedAt: Date.now() }
      return {
        ...s,
        tools: { ...s.tools, [e.toolCallId]: { ...t, status: e.isError ? 'error' : 'ok', result: e.result, durationMs: e.durationMs } },
      }
    }
    case 'queue_update':
      return { ...s, queue: { steering: e.steering, followUp: e.followUp } }
    case 'extension_ui_request':
      if (!DIALOGS.has(e.method)) return s
      return { ...s, uiRequests: [...s.uiRequests, e] }
    default:
      return s
  }
}

export function reducer(s: SessionStore, a: Action): SessionStore {
  switch (a.type) {
    case 'load':
      return { ...s, loaded: true, messages: a.messages.filter(isChat), draft: null, streaming: a.streaming }
    case 'events':
      return a.events.reduce(apply, s)
    case 'ui_done':
      return { ...s, uiRequests: s.uiRequests.filter((r) => r.id !== a.id) }
    case 'clear_exit':
      return { ...s, exit: null }
  }
}
