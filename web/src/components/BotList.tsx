import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { CalendarClockIcon, ChevronRightIcon, Loader2Icon, PlusIcon, SearchIcon, SettingsIcon, SparklesIcon, TerminalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { fmtShort } from '@/lib/format'
import type { Route } from '@/lib/route'
import { isUnread } from '@/lib/seen'
import type { Bot, SessionSummary, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { BotAvatar } from './BotAvatar'
import { BotDialog } from './BotDialog'

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}

const isTaskRun = (id: string) => id.startsWith('pimu-t')
// Previews are raw markdown; drop the syntax characters.
const plain = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim()

export function BotList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [q, setQ] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  // Animate reorders (a bot jumping to the top) with View Transitions where supported.
  const order = useRef('')
  const load = () => {
    api<{ bots: Bot[] }>('/api/bots')
      .then((r) => {
        const next = r.bots.map((b) => `${b.id}:${b.status}:${b.updatedAt}`).join()
        const vt = (document as Document & { startViewTransition?: (cb: () => void) => void }).startViewTransition
        if (order.current && next !== order.current && vt && !matchMedia('(prefers-reduced-motion: reduce)').matches) vt.call(document, () => flushSync(() => setBots(r.bots)))
        else setBots(r.bots)
        order.current = next
      })
      .catch(() => {})
    api<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => setSessions(r.sessions)).catch(() => {})
    api<{ runs: TaskRun[] }>('/api/runs?status=running&limit=20').then((r) => setRuns(r.runs)).catch(() => {})
  }
  useEffect(() => {
    load()
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    return () => clearInterval(t)
  }, [])
  useGlobalEvents(load)

  const ql = q.trim().toLowerCase()
  const match = (...s: (string | undefined)[]) => !ql || s.join(' ').toLowerCase().includes(ql)
  const byId = useMemo(() => new Map((bots ?? []).map((b) => [b.id, b])), [bots])

  // Busy first, then unread, then most recent — like a messaging app.
  const [active, archived] = useMemo(() => {
    const rank = (b: Bot) => (b.status === 'streaming' ? 2 : b.id !== activeId && isUnread(b.id, b.updatedAt) && b.lastRole === 'assistant' ? 1 : 0)
    const list = (bots ?? []).filter((b) => match(b.name, b.description, b.last))
    list.sort((a, b) => rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return [list.filter((b) => !b.archived), list.filter((b) => b.archived)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, ql, activeId])
  const others = sessions.filter((s) => !byId.has(s.id) && !isTaskRun(s.id) && match(s.name, s.preview))

  const row = (b: Bot) => {
    const unread = b.id !== activeId && b.lastRole === 'assistant' && isUnread(b.id, b.updatedAt)
    return (
      <a
        key={b.id}
        href={`#/s/${b.id}`}
        style={{ viewTransitionName: `bot-${b.id}` }}
        aria-current={b.id === activeId ? 'page' : undefined}
        className="pressable mx-2 flex items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-foreground/[0.04] aria-[current=page]:bg-accent"
      >
        <span className="relative">
          <BotAvatar id={b.id} className="size-12" />
          {b.status === 'streaming' && <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-2 border-background bg-emerald-500" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 truncate text-[15px] ${unread ? 'font-semibold' : 'font-medium'}`}>{b.name}</span>
            <span className={`shrink-0 text-xs tabular-nums ${unread ? 'text-primary' : 'text-muted-foreground'}`}>{fmtShort(b.updatedAt)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>
              {b.status === 'streaming' ? <span className="shimmer">正在回复…</span> : b.last ? `${b.lastRole === 'user' ? '我：' : ''}${plain(b.last)}` : b.description || '还没有对话'}
            </span>
            {b.status === 'streaming' ? (
              <span className="sr-only">运行中</span>
            ) : (
              unread && <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-label="未读" />
            )}
          </div>
        </div>
      </a>
    )
  }

  const fold = (title: string, n: number, children: ReactNode) =>
    n > 0 && (
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-1 text-left text-xs text-muted-foreground">
          <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          {title}（{n}）
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    )

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <div className="flex-1 py-2">
          <p className="text-xs text-muted-foreground">{greeting()}</p>
          <h1 className="font-heading text-[26px] leading-tight font-semibold tracking-tight">Pimu</h1>
        </div>
        <Button asChild size="icon" variant={route === 'tasks' || route === 'task' ? 'secondary' : 'ghost'} className="size-11 rounded-full">
          <a href="#/tasks" aria-label="任务" title="任务">
            <CalendarClockIcon />
          </a>
        </Button>
        <Button asChild size="icon" variant={route === 'settings' ? 'secondary' : 'ghost'} className="size-11 rounded-full">
          <a href="#/settings" aria-label="设置" title="设置">
            <SettingsIcon />
          </a>
        </Button>
        <Button size="icon" className="size-11 rounded-full shadow-soft" aria-label="新建 Bot" title="新建 Bot" onClick={() => setNewOpen(true)}>
          <PlusIcon />
        </Button>
      </header>
      <div className="relative px-4 pt-1 pb-3">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-7 size-4 -translate-y-[calc(50%-2px)] text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="min-h-11 rounded-xl border-transparent bg-foreground/[0.05] pl-9 text-base shadow-none" aria-label="搜索" />
        <kbd className="pointer-events-none absolute top-1/2 right-7 hidden -translate-y-[calc(50%-2px)] rounded border px-1.5 font-mono text-[10px] text-muted-foreground lg:block">⌘K</kbd>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {runs.length > 0 && (
          <section aria-label="正在进行" className="mx-4 mb-3 overflow-hidden rounded-xl border bg-card shadow-soft">
            <h2 className="px-3 pt-2 text-xs font-medium text-muted-foreground">正在进行</h2>
            {runs.map((r) => {
              const b = r.sessionId ? byId.get(r.sessionId) : undefined
              return (
                <a key={r.id} href={r.sessionId ? `#/s/${r.sessionId}` : `#/tasks/${r.taskId}`} className="flex min-h-11 items-center gap-2 px-3 py-2 hover:bg-muted/60">
                  {b ? <BotAvatar id={b.id} className="size-5" /> : <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {b ? `${b.name} · ` : ''}
                    {r.taskName}
                  </span>
                  <Loader2Icon className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-label="运行中" />
                </a>
              )
            })}
          </section>
        )}
        {!bots && <div className="space-y-2 px-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {bots && active.length === 0 && !ql && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <SparklesIcon className="mx-auto size-8 text-primary" />
            <p className="mt-3">还没有 Bot。给每件事一个专属助手。</p>
            <Button className="mt-4 min-h-11" onClick={() => setNewOpen(true)}>
              <PlusIcon /> 新建 Bot
            </Button>
          </div>
        )}
        {active.map(row)}
        <div className="mx-4 mt-3 border-t pt-1">
          {fold(
            '终端会话',
            others.length,
            others.map((s) => (
              <a key={s.id} href={`#/s/${s.id}`} title="在终端用 pi 开的会话；打开后可“设为 Bot”" className={`-mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 py-2 hover:bg-foreground/[0.04] ${s.id === activeId ? 'bg-accent' : ''}`}>
                <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{s.name || s.preview || '（空会话）'}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtShort(s.updatedAt)}</span>
              </a>
            )),
          )}
          {fold('已归档', archived.length, <div className="-mx-4">{archived.map(row)}</div>)}
        </div>
      </nav>
      <BotDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
