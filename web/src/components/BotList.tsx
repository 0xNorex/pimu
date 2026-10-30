import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { CalendarClockIcon, ChevronRightIcon, FolderIcon, Loader2Icon, PlusIcon, SearchIcon, SettingsIcon, SparklesIcon, TerminalIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errMsg } from '@/lib/api'
import { fmtShort } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { isUnread } from '@/lib/seen'
import type { Bot, SessionSummary, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { BotAvatar } from './BotAvatar'

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
}

// Task runs (pimu-t…) and heartbeats (pimu-g…) live under their task/goal, not here.
const isBackground = (id: string) => /^pimu-[tg]\d/.test(id)
// "/home/me/proj/x" -> "~/proj/x"
export const shortPath = (p: string, home: string) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p)

// Creating always means a new session; any session can later be set as a bot.
export async function newSession(cwd?: string) {
  const t = toast.loading('正在开新会话…')
  try {
    const r = await api<{ id: string }>('/api/sessions', { cwd: cwd ?? '' })
    toast.dismiss(t)
    go(`#/s/${r.id}`)
  } catch (e) {
    toast.error(errMsg(e), { id: t })
  }
}
// Previews are raw markdown; drop the syntax characters.
const plain = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim()

export function BotList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [q, setQ] = useState('')
  const [dirs, setDirs] = useState<{ workdirs: string[]; home: string }>({ workdirs: [], home: '' })
  const [more, setMore] = useState<Record<string, boolean>>({})

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
        {dirs.workdirs.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" className="size-11 rounded-full shadow-soft" aria-label="新会话" title="新会话">
                <PlusIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">新会话，在哪个目录？</DropdownMenuLabel>
              {dirs.workdirs.map((d) => (
                <DropdownMenuItem key={d} className="min-h-11 font-mono text-xs" onSelect={() => void newSession(d)}>
                  <FolderIcon /> {shortPath(d, dirs.home)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button size="icon" className="size-11 rounded-full shadow-soft" aria-label="新会话" title="新会话" onClick={() => void newSession()}>
            <PlusIcon />
          </Button>
        )}
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
        {bots && active.length === 0 && groups.length === 0 && !ql && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <SparklesIcon className="mx-auto size-8 text-primary" />
            <p className="mt-3">开个会话聊起来；常用的会话可以“设为 Bot”，置顶在这里。</p>
            <Button className="mt-4 min-h-11" onClick={() => void newSession()}>
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
            <section key={g.cwd} aria-label={shortPath(g.cwd, dirs.home)} className="mt-3">
              <h2 className="flex items-center gap-1.5 px-4 pb-1 text-xs text-muted-foreground" title={g.cwd}>
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">{shortPath(g.cwd, dirs.home)}</span>
                <span className="tabular-nums">{g.list.length}</span>
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
        <div className="mx-4 mt-3 border-t pt-1">{fold('已归档 Bot', archived.length, <div className="-mx-4">{archived.map(row)}</div>)}</div>
      </nav>
    </div>
  )
}
