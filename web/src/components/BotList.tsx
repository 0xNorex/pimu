import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BrainIcon, CalendarClockIcon, ChevronRightIcon, Loader2Icon, LogOutIcon, MessageSquareIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { fmtShort } from '@/lib/format'
import { go } from '@/lib/route'
import type { Route } from '@/lib/route'
import { isUnread } from '@/lib/seen'
import type { Bot, SessionSummary, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { BotAvatar } from './BotAvatar'
import { BotDialog } from './BotDialog'

const isTaskRun = (id: string) => id.startsWith('pimu-t')
// Previews are raw markdown; drop the syntax characters.
const plain = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim()

export function BotList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [q, setQ] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  const load = () => {
    api<{ bots: Bot[] }>('/api/bots').then((r) => setBots(r.bots)).catch(() => {})
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

  const logout = async () => {
    await api('/api/logout', {}).catch(() => {})
    go('#/login')
  }

  const row = (b: Bot) => {
    const unread = b.id !== activeId && b.lastRole === 'assistant' && isUnread(b.id, b.updatedAt)
    return (
      <a key={b.id} href={`#/s/${b.id}`} className={`flex items-center gap-3 px-3 py-2.5 hover:bg-muted/60 ${b.id === activeId ? 'bg-muted' : ''}`}>
        <BotAvatar id={b.id} className="size-12" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 truncate text-[15px] ${unread ? 'font-semibold' : 'font-medium'}`}>{b.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{fmtShort(b.updatedAt)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>
              {b.status === 'streaming' ? '正在回复…' : b.last ? `${b.lastRole === 'user' ? '我：' : ''}${plain(b.last)}` : b.description || '还没有对话'}
            </span>
            {b.status === 'streaming' ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-label="运行中" />
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
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-1 px-3 text-left text-xs text-muted-foreground">
          <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          {title}（{n}）
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    )

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 px-3 pt-[env(safe-area-inset-top)]">
        <h1 className="flex-1 py-3 text-xl font-semibold">Pimu</h1>
        <Button asChild size="icon" variant={route === 'tasks' || route === 'task' ? 'secondary' : 'ghost'} className="size-11">
          <a href="#/tasks" aria-label="任务" title="任务">
            <CalendarClockIcon />
          </a>
        </Button>
        <Button asChild size="icon" variant={route === 'memory' ? 'secondary' : 'ghost'} className="size-11">
          <a href="#/memory" aria-label="记忆" title="记忆">
            <BrainIcon />
          </a>
        </Button>
        <Button size="icon" variant="ghost" className="size-11" aria-label="退出登录" title="退出登录" onClick={logout}>
          <LogOutIcon />
        </Button>
        <Button size="icon" className="size-11 rounded-full" aria-label="新建 Bot" title="新建 Bot" onClick={() => setNewOpen(true)}>
          <PlusIcon />
        </Button>
      </header>
      <div className="px-3 pb-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="min-h-11 rounded-full bg-muted/60 text-base" aria-label="搜索" />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {runs.length > 0 && (
          <section aria-label="正在进行" className="mx-3 mb-2 rounded-lg border bg-muted/30">
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
            <p className="text-3xl">🤖</p>
            <p className="mt-2">还没有 Bot。给每件事一个专属助手。</p>
            <Button className="mt-4 min-h-11" onClick={() => setNewOpen(true)}>
              <PlusIcon /> 新建 Bot
            </Button>
          </div>
        )}
        {active.map(row)}
        <div className="mt-2 border-t pt-1">
          {fold(
            '其他会话',
            others.length,
            others.map((s) => (
              <a key={s.id} href={`#/s/${s.id}`} className={`flex min-h-11 items-center gap-3 px-3 py-2 hover:bg-muted/60 ${s.id === activeId ? 'bg-muted' : ''}`}>
                <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{s.name || s.preview || '（空会话）'}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtShort(s.updatedAt)}</span>
              </a>
            )),
          )}
          {fold('已归档', archived.length, archived.map(row))}
        </div>
      </nav>
      <BotDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
