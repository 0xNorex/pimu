import type { Message, ToolCallBlock } from './types'

export function textOf(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

// One-line summary of a tool call: bash → command, file tools → path, else first string arg.
export function toolSummary(call: Pick<ToolCallBlock, 'name' | 'arguments'>): string {
  const a = call.arguments ?? {}
  const pick = call.name === 'bash' ? a.command : a.path ?? a.file_path
  const first = typeof pick === 'string' ? pick : Object.values(a).find((v) => typeof v === 'string')
  return truncate(typeof first === 'string' ? first : '', 60)
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const fmtTime = (t: number) => timeFmt.format(t)
export const fmtDate = (t: string | number) => dateFmt.format(new Date(t))
export const fmtMs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export function fmtDuration(from?: string | null, to?: string | null): string {
  if (!from || !to) return ''
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
}

const CRON_LABELS: Record<string, string> = {
  '* * * * *': '每分钟',
  '*/5 * * * *': '每 5 分钟',
  '0 * * * *': '每小时',
  '0 9 * * *': '每天 09:00',
  '0 9 * * 1-5': '工作日 09:00',
  '0 9 * * 1': '每周一 09:00',
}
export const cronLabel = (spec: string | null) => (spec ? CRON_LABELS[spec] ?? spec : '仅手动')
export const CRON_PRESETS = Object.entries(CRON_LABELS)

// Messaging-style time: HH:mm today, 昨天, else M/D.
export function fmtShort(t: string): string {
  const d = new Date(t)
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (diff === 1) return '昨天'
  return `${d.getMonth() + 1}/${d.getDate()}`
}
export const every = (sec: number) => (sec % 3600 === 0 ? `每 ${sec / 3600} 小时` : `每 ${Math.round(sec / 60)} 分钟`)
