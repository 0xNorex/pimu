// Minimal hand-written subset of pi's RPC types (docs: json.md, message-types.md).
export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; data: string; mimeType: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string; redacted?: boolean }
export type ToolCallBlock = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock

export type UserMessage = { role: 'user'; content: string | (TextBlock | ImageBlock)[]; timestamp: number }
export type AssistantMessage = {
  role: 'assistant'
  content: AssistantBlock[]
  model?: string
  stopReason?: string
  errorMessage?: string
  timestamp: number
}
export type ToolResultMessage = {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextBlock | ImageBlock)[]
  details?: unknown
  isError: boolean
  timestamp: number
}
// pi inserts one when it compacts the context (manual /compact or automatic).
export type CompactionMessage = { role: 'compactionSummary'; summary?: string; tokensBefore?: number; timestamp: number }
export type Message = UserMessage | AssistantMessage | ToolResultMessage | CompactionMessage

export type ToolResult = { content?: (TextBlock | ImageBlock)[]; details?: unknown }

type AssistantEvent =
  | { type: 'text_start' | 'thinking_start'; contentIndex: number }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; id: string; toolName: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallBlock }

export type UIRequest = {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  notifyType?: 'info' | 'warning' | 'error'
}

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'message_start' | 'message_end'; message: Message | { role: 'system' | 'custom' } }
  | { type: 'message_update'; assistantMessageEvent: AssistantEvent }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_execution_update'; toolCallId: string; partialResult: ToolResult }
  | { type: 'tool_execution_end'; toolCallId: string; result: ToolResult; isError: boolean; durationMs?: number }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'auto_compaction_end'; aborted?: boolean }
  | UIRequest

export type PimuEvent =
  | { type: 'proc_state'; state: 'starting' | 'ready' | 'exited'; code?: number; stderrTail?: string }
  | { type: 'lock'; holder: 'pimu' | 'external' | 'none' }
  | { type: 'resync' }

export type Incoming = { kind: 'pi'; data: PiEvent } | { kind: 'pimu'; data: PimuEvent }

export type Model = { id: string; name: string; provider: string; reasoning?: boolean }

export type SessionStatus = 'idle' | 'running' | 'streaming' | 'external'

// The built-in bot for ad-hoc questions: always there, can be renamed, not archived.
export const ASSISTANT = 'pm-assistant'

// An earlier conversation of a bot (详情 → 历史); read-only until resumed.
export type Topic = { id: string; title: string; cwd: string; updatedAt: string }

// A bot: its current pi session (id = bot id) plus display metadata (Pimu's bots table).
export type Bot = {
  id: string
  name: string
  description: string
  persona: string
  cwd: string
  archived: boolean
  mode: 'trusted' | 'guarded'
  createdAt: string
  updatedAt: string
  status: SessionStatus
  last?: string
  lastRole?: 'user' | 'assistant'
  jobsRunning?: number
  paused?: boolean
}

export type SessionState = {
  model?: Model
  thinkingLevel?: string
  isStreaming?: boolean
  sessionName?: string
}

export type SessionDetail = { id: string; path?: string; cwd?: string; name?: string; updatedAt?: string; topicOf?: string; status: SessionStatus; state?: SessionState }

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted'
export type TaskRun = {
  id: number
  taskId: number
  taskName: string
  trigger: 'cron' | 'manual' | 'retry'
  attempt: number
  status: RunStatus
  sessionId: string | null
  summary: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}
export type Task = {
  id: number
  name: string
  prompt: string
  cwd: string
  schedule: string | null
  model: string | null
  sessionMode: 'new' | 'reuse'
  sessionId: string | null
  notify: 'always' | 'failure' | 'never'
  maxRetries: number
  timeoutSec: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  nextRun: string | null
  lastRun: TaskRun | null
}
export type GlobalEvent =
  | { type: 'run_update'; run: TaskRun }
  | { type: 'proc_state'; id: string; state: string }
  | { type: 'inbox' }
  | { type: 'goal_update'; goalId: number }
  | { type: 'job_update'; job: Job }
  | { type: 'resync' }

export type Beat = { id: number; goalId: number; sessionId: string; status: 'running' | 'ok' | 'budget' | 'error'; tokens: number; outcome: string; summary: string; startedAt: string; finishedAt: string | null }

export type Goal = {
  id: number
  botId: string
  slug: string
  title: string
  level: 1 | 2
  everySec: number
  activeHours: string
  runSec: number
  runTokens: number
  dayTokens: number
  enabled: boolean
  nextAt: string | null
  createdAt: string
  todayTokens: number
  lastBeat: Beat | null
  precheck: string
  botName?: string
}

export type GoalDetail = { goal: Goal; goalMd: string; stateMd: string; findings: string; beats: Beat[]; hookUrl: string; dir: string }

export type InboxItem = {
  id: number
  goalId: number
  jobId: number
  kind: 'notify' | 'ask' | 'approval'
  title: string
  body: string
  tool: string
  status: 'new' | 'read' | 'approved' | 'denied' | 'used' | 'expired'
  createdAt: string
  decidedAt: string | null
  goalTitle: string
  botId: string
  botName: string
}

export type Job = {
  id: number
  botId: string
  title: string
  prompt: string
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  sessionId: string
  result: string
  error: string
  tokens: number
  delivered: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  approvals: { approval_count: number; approved: number; denied: number; expired: number; pending: number }
}
