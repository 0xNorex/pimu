import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { BellIcon, CalendarClockIcon, ChevronRightIcon, FolderIcon, Loader2Icon, PlusIcon, SearchIcon, SettingsIcon, SquarePenIcon, TerminalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { fmtShort, shortPath } from '@/lib/format'
import type { Route } from '@/lib/route'
import { isUnread } from '@/lib/seen'
import type { Bot, SessionSummary, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { BotAvatar } from './BotAvatar'
import { openNewSession } from './NewSessionDialog'

// Task runs (pimu-t…), heartbeats (pimu-g…) and background jobs (pimu-j…) live under their task/goal/bot, not here.
const isBackground = (id: string) => /^pimu-[tgj]\d/.test(id)
// Previews are raw markdown; drop the syntax characters.
const plain = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim()

export function BotList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [q, setQ] = useState('')
  const [dirs, setDirs] = useState<{ workdirs: string[]; home: string }>({ workdirs: [], home: '' })
  const [more, setMore] = useState<Record<string, boolean>>({})
  const [unread, setUnread] = useState(0)

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
    api<{ unread: number }>('/api/inbox/count').then((r) => setUnread(r.unread)).catch(() => {})
  }
  useEffect(() => {
    load()
    api<{ workdirs: string[]; home: string }>('/api/workdirs').then(setDirs).catch(() => {})
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
  // Every other session, grouped by working directory (newest group first).
  const groups = useMemo(() => {
    const m = new Map<string, SessionSummary[]>()
    for (const s of sessions) {
      if (byId.has(s.id) || isBackground(s.id) || !match(s.name, s.preview, s.cwd)) continue
      m.set(s.cwd, [...(m.get(s.cwd) ?? []), s])
    }
    const out = [...m.entries()].map(([cwd, list]) => ({ cwd, list: list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) }))
    return out.sort((a, b) => Date.parse(b.list[0].updatedAt) - Date.parse(a.list[0].updatedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, byId, ql])
  const PAGE = 8
  // Folder name, with the parent only when two groups share it; the home dir reads as 主目录.
  const dirLabel = (cwd: string) => {
    if (cwd === dirs.home) return '主目录'
    const base = cwd.split('/').filter(Boolean).pop() ?? cwd
    const clash = groups.filter((g) => g.cwd.split('/').filter(Boolean).pop() === base).length > 1
    return clash ? shortPath(cwd, dirs.home) : base
  }

  const row = (b: Bot) => {
    const unread = b.id !== activeId && b.lastRole === 'assistant' && isUnread(b.id, b.updatedAt)
    return (
      <a
        key={b.id}
        href={`#/s/${b.id}`}
        style={{ viewTransitionName: `bot-${b.id}` }}
        aria-current={b.id === activeId ? 'page' : undefined}
        className="pressable mx-2 flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-foreground/[0.04] aria-[current=page]:bg-accent"
      >
        <span className="relative">
          <BotAvatar id={b.id} className="size-10" />
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
      <header className="flex h-14 shrink-0 items-center gap-0.5 pr-2 pl-4 pt-[env(safe-area-inset-top)] box-content">
        <h1 className="flex-1 font-heading text-[17px] font-semibold tracking-tight">Pimu</h1>
        <Button asChild size="icon" variant={route === 'inbox' ? 'secondary' : 'ghost'} className="relative size-10 lg:size-9">
          <a href="#/inbox" aria-label={unread ? `收件箱（${unread} 条未读）` : '收件箱'} title="收件箱">
            <BellIcon />
            {unread > 0 && <span className="absolute top-1 right-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">{unread > 99 ? '99+' : unread}</span>}
          </a>
        </Button>
        <Button size="icon" variant="ghost" className="size-10 lg:size-9" aria-label="新会话" title="新会话" onClick={() => openNewSession()}>
          <SquarePenIcon />
        </Button>
      </header>
      <div className="relative px-3 pb-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-[calc(50%+4px)] text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-10 rounded-lg border-transparent bg-foreground/[0.05] pl-9 text-base shadow-none lg:h-9 lg:text-sm" aria-label="搜索" />
        <kbd className="pointer-events-none absolute top-1/2 right-6 hidden -translate-y-[calc(50%+4px)] rounded border px-1.5 font-mono text-[10px] text-muted-foreground lg:block">⌘K</kbd>
      </div>
      <ScrollArea className="flex-1">
      <nav className="pb-3">
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
        {bots && active.length === 0 && groups.length === 0 && !ql && (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">还没有会话</p>
            <p className="mt-1">开个会话聊起来；常用的可以“设为 Bot”，置顶在这里。</p>
            <Button className="mt-4 h-10" onClick={() => openNewSession()}>
              <PlusIcon /> 新会话
            </Button>
          </div>
        )}
        {active.length > 0 && (
          <section aria-label="Bot">
            <h2 className="px-4 pb-1 text-xs font-medium text-muted-foreground">Bot</h2>
            {active.map(row)}
          </section>
        )}
        {groups.map((g) => {
          const shown = more[g.cwd] ? g.list : g.list.slice(0, PAGE)
          return (
            <section key={g.cwd} aria-label={dirLabel(g.cwd)} className="mt-4">
              <h2 className="flex items-center gap-1.5 px-4 pb-1 text-xs font-medium text-muted-foreground" title={g.cwd}>
                <FolderIcon className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{dirLabel(g.cwd)}</span>
              </h2>
              {shown.map((s) => (
                <a
                  key={s.id}
                  href={`#/s/${s.id}`}
                  aria-current={s.id === activeId ? 'page' : undefined}
                  title={s.id.startsWith('pm-') ? undefined : '在终端用 pi 开的会话'}
                  className="pressable mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-foreground/[0.04] aria-[current=page]:bg-accent"
                >
                  {s.status === 'streaming' ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-label="运行中" />
                  ) : s.id.startsWith('pm-') ? (
                    <span className="size-4 shrink-0" aria-hidden />
                  ) : (
                    <TerminalIcon className="size-4 shrink-0 text-muted-foreground" aria-label="终端会话" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{s.name || (s.preview ? plain(s.preview) : '新会话')}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtShort(s.updatedAt)}</span>
                </a>
              ))}
              {g.list.length > PAGE && !more[g.cwd] && (
                <button type="button" className="mx-4 min-h-9 text-xs text-primary" onClick={() => setMore((m) => ({ ...m, [g.cwd]: true }))}>
                  再显示 {g.list.length - PAGE} 个
                </button>
              )}
            </section>
          )
        })}
        {archived.length > 0 && <div className="mx-4 mt-3">{fold('已归档 Bot', archived.length, <div className="-mx-4">{archived.map(row)}</div>)}</div>}
      </nav>
      </ScrollArea>
      <footer className="flex shrink-0 gap-1 border-t px-2 py-1.5 pb-[max(env(safe-area-inset-bottom),0.375rem)]">
        {(
          [
            ['#/tasks', '任务', CalendarClockIcon, route === 'tasks' || route === 'task'],
            ['#/settings', '设置', SettingsIcon, route === 'settings'],
          ] as const
        ).map(([href, label, Icon, on]) => (
          <a key={href} href={href} aria-current={on ? 'page' : undefined} className="pressable flex h-10 flex-1 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground lg:h-9">
            <Icon className="size-4" /> {label}
          </a>
        ))}
      </footer>
    </div>
  )
}
