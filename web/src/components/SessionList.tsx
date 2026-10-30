import { useEffect, useMemo, useState } from 'react'
import { BrainIcon, CalendarClockIcon, ChevronRightIcon, Loader2Icon, LogOutIcon, PlusIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import { go } from '@/lib/route'
import type { Route } from '@/lib/route'
import type { SessionSummary, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { NewSessionDialog } from './NewSessionDialog'

const STATUS: Record<SessionSummary['status'], string | null> = { idle: null, running: '运行中', streaming: '生成中', external: '终端占用' }

export function SessionList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [q, setQ] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  const load = () => {
    api<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => setSessions(r.sessions)).catch(() => {})
    api<{ runs: TaskRun[] }>('/api/runs?status=running&limit=20').then((r) => setRuns(r.runs)).catch(() => {})
  }
  useEffect(() => {
    load()
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    return () => clearInterval(t)
  }, [])
  useGlobalEvents(load)

  // 正在进行: running task runs first, then live chat sessions that are not task runs.
  const taskSessions = new Set(runs.map((r) => r.sessionId))
  const live = (sessions ?? []).filter((s) => s.status === 'streaming' && !taskSessions.has(s.id))

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const m = new Map<string, SessionSummary[]>()
    for (const s of sessions ?? []) {
      if (ql && !`${s.name ?? ''} ${s.preview ?? ''}`.toLowerCase().includes(ql)) continue
      m.set(s.cwd, [...(m.get(s.cwd) ?? []), s])
    }
    return [...m.entries()]
  }, [sessions, q])

  const logout = async () => {
    await api('/api/logout', {}).catch(() => {})
    go('#/login')
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 pt-[env(safe-area-inset-top)]">
        <h1 className="flex-1 py-3 text-base font-semibold">Pimu</h1>
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
        <Button size="icon" variant="ghost" className="size-11" aria-label="退出登录" onClick={logout}>
          <LogOutIcon />
        </Button>
        <Button size="icon" className="size-11" aria-label="新建会话" onClick={() => setNewOpen(true)}>
          <PlusIcon />
        </Button>
      </header>
      <div className="p-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索会话" className="min-h-11 text-base" aria-label="搜索会话" />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {!sessions && <div className="space-y-2 px-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
        {sessions?.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <p>还没有 pi 会话。</p>
            <Button className="mt-3" onClick={() => setNewOpen(true)}>
              新建会话
            </Button>
          </div>
        )}
        {(runs.length > 0 || live.length > 0) && (
          <section aria-label="正在进行" className="mb-1 border-b pb-1">
            <h2 className="px-3 py-2 text-xs font-medium text-muted-foreground">正在进行</h2>
            {runs.map((r) => (
              <a key={`r${r.id}`} href={r.sessionId ? `#/s/${r.sessionId}` : `#/tasks/${r.taskId}`} className={`flex min-h-11 items-center gap-2 px-4 py-2 hover:bg-muted/60 ${r.sessionId === activeId ? 'bg-muted' : ''}`}>
                <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[15px]">{r.taskName}</span>
                <Badge variant="secondary">
                  <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                  任务
                </Badge>
              </a>
            ))}
            {live.map((s) => (
              <a key={s.id} href={`#/s/${s.id}`} className={`flex min-h-11 items-center gap-2 px-4 py-2 hover:bg-muted/60 ${s.id === activeId ? 'bg-muted' : ''}`}>
                <span className="min-w-0 flex-1 truncate text-[15px]">{s.name || s.preview || s.id}</span>
                <Badge variant="secondary">{STATUS[s.status]}</Badge>
              </a>
            ))}
          </section>
        )}
        {groups.map(([cwd, list]) => (
          <Collapsible key={cwd} defaultOpen>
            <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-1 px-3 text-left text-xs text-muted-foreground">
              <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
              <span className="truncate font-mono">{cwd}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {list.map((s) => (
                <a key={s.id} href={`#/s/${s.id}`} className={`block min-h-11 px-4 py-2 hover:bg-muted/60 ${s.id === activeId ? 'bg-muted' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[15px]">{s.name || s.preview || s.id}</span>
                    {STATUS[s.status] && <Badge variant={s.status === 'external' ? 'outline' : 'secondary'}>{STATUS[s.status]}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{fmtDate(s.updatedAt)}</div>
                </a>
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </nav>
      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
