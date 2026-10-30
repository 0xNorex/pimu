import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ArrowRightIcon, BellIcon, CalendarClockIcon, ChevronRightIcon, FolderIcon, Loader2Icon, PlusIcon, SearchIcon, SettingsIcon, ShieldAlertIcon, SquarePenIcon, TerminalIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { BOTS_CHANGED, transition, type BotsChanged } from '@/lib/bus'
import { fmtShort, shortPath } from '@/lib/format'
import type { Route } from '@/lib/route'
import { isUnread } from '@/lib/seen'
import type { Bot, InboxItem, SessionSummary, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { BotAvatar } from './BotAvatar'
import { openNewSession } from './NewSessionDialog'

// Task runs (pimu-t…), heartbeats (pimu-g…) and background jobs (pimu-j…) live under their task/goal/bot, not here.
const isBackground = (id: string) => /^pimu-[tgj]\d/.test(id)
// Previews are raw markdown; drop the syntax characters.
const plain = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim()

type Tab = 'bots' | 'sessions'
const TAB_KEY = 'pimu.sidebarTab'
const TABS: [Tab, string][] = [
  ['bots', 'Bot'],
  ['sessions', '会话'],
]
const savedTab = (): Tab => (localStorage.getItem(TAB_KEY) === 'sessions' ? 'sessions' : 'bots')
// Rows fade up one after another; capped so long lists don't wait.
const stagger = (i: number) => ({ '--i': Math.min(i, 12) }) as CSSProperties
// One name per row, shared by its Bot and 会话 forms: moving tabs morphs the row.
const vtName = (id: string) => ({ viewTransitionName: `row-${id}` }) as CSSProperties

export function BotList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [waiting, setWaiting] = useState<Map<string, number>>(new Map())
  const [q, setQ] = useState('')
  const [tab, setTabState] = useState<Tab>(savedTab)
  const [dir, setDir] = useState<'l' | 'r' | null>('r')
  const [dirs, setDirs] = useState<{ workdirs: string[]; home: string }>({ workdirs: [], home: '' })
  const [more, setMore] = useState<Record<string, boolean>>({})
  const [unread, setUnread] = useState(0)
  const [bump, setBump] = useState<Tab | null>(null)
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ bots: null, sessions: null })

  const setTab = (t: Tab) => {
    if (t === tab) return
    setDir(t === 'sessions' ? 'r' : 'l')
    setTabState(t)
    localStorage.setItem(TAB_KEY, t)
  }

  const fetchAll = () =>
    Promise.all([
      api<{ bots: Bot[] }>('/api/bots').then((r) => r.bots),
      api<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => r.sessions),
    ])
  // Animate reorders (a bot jumping to the top) with View Transitions where supported.
  const order = useRef('')
  const load = () => {
    fetchAll()
      .then(([b, s]) => {
        const next = b.map((x) => `${x.id}:${x.status}:${x.updatedAt}`).join()
        const apply = () => flushSync(() => (setBots(b), setSessions(s)))
        if (order.current && next !== order.current) transition(apply)
        else apply()
        order.current = next
      })
      .catch(() => {})
    api<{ runs: TaskRun[] }>('/api/runs?status=running&limit=20').then((r) => setRuns(r.runs)).catch(() => {})
    api<{ unread: number }>('/api/inbox/count').then((r) => setUnread(r.unread)).catch(() => {})
    api<{ items: InboxItem[] }>('/api/inbox?open=1')
      .then((r) => {
        const m = new Map<string, number>()
        for (const it of r.items) if (it.kind === 'approval' && it.botId && it.status === 'new') m.set(it.botId, (m.get(it.botId) ?? 0) + 1)
        setWaiting(m)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
    api<{ workdirs: string[]; home: string }>('/api/workdirs').then(setDirs).catch(() => {})
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useGlobalEvents(load)

  // Set / unset as bot: follow the row to its new tab, morphing it across.
  useEffect(() => {
    const on = (e: Event) => {
      const { bot } = (e as CustomEvent<BotsChanged>).detail
      const to: Tab = bot ? 'bots' : 'sessions'
      fetchAll()
        .then(([b, s]) => {
          order.current = b.map((x) => `${x.id}:${x.status}:${x.updatedAt}`).join()
          transition(() =>
            flushSync(() => {
              setBots(b)
              setSessions(s)
              setDir(null) // the transition animates this one
              setTabState(to)
              localStorage.setItem(TAB_KEY, to)
            }),
          'move',
          )
          setBump(to)
          setTimeout(() => setBump(null), 700)
        })
        .catch(() => {})
    }
    addEventListener(BOTS_CHANGED, on)
    return () => removeEventListener(BOTS_CHANGED, on)
  }, [])

  const ql = q.trim().toLowerCase()
  const match = (...s: (string | undefined)[]) => !ql || s.join(' ').toLowerCase().includes(ql)
  const byId = useMemo(() => new Map((bots ?? []).map((b) => [b.id, b])), [bots])
  const busy = useMemo(() => new Set(runs.map((r) => r.sessionId).filter(Boolean) as string[]), [runs])
  const isUnreadBot = (b: Bot) => b.id !== activeId && b.lastRole === 'assistant' && isUnread(b.id, b.updatedAt)

  // Busy first, then waiting / unread, then most recent — like a messaging app.
  const [active, archived] = useMemo(() => {
    const rank = (b: Bot) => (b.status === 'streaming' ? 3 : waiting.has(b.id) ? 2 : isUnreadBot(b) ? 1 : 0)
    const list = (bots ?? []).filter((b) => match(b.name, b.description, b.last))
    list.sort((a, b) => rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return [list.filter((b) => !b.archived), list.filter((b) => b.archived)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, ql, activeId, waiting])
  // Every other session, grouped by working directory (newest group first).
  const plainSessions = useMemo(() => (sessions ?? []).filter((s) => !byId.has(s.id) && !isBackground(s.id)), [sessions, byId])
  const groups = useMemo(() => {
    const m = new Map<string, SessionSummary[]>()
    for (const s of plainSessions) {
      if (!match(s.name, s.preview, s.cwd)) continue
      m.set(s.cwd, [...(m.get(s.cwd) ?? []), s])
    }
    const out = [...m.entries()].map(([cwd, list]) => ({ cwd, list: list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) }))
    return out.sort((a, b) => Date.parse(b.list[0].updatedAt) - Date.parse(a.list[0].updatedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plainSessions, ql])
  const nSessions = groups.reduce((n, g) => n + g.list.length, 0)
  const nBots = active.length + archived.length
  const unreadBots = (bots ?? []).filter((b) => !b.archived && (isUnreadBot(b) || waiting.has(b.id))).length
  const PAGE = 8
  // Folder name, with the parent only when two groups share it; the home dir reads as 主目录.
  const dirLabel = (cwd: string) => {
    if (cwd === dirs.home) return '主目录'
    const base = cwd.split('/').filter(Boolean).pop() ?? cwd
    const clash = groups.filter((g) => g.cwd.split('/').filter(Boolean).pop() === base).length > 1
    return clash ? shortPath(cwd, dirs.home) : base
  }

  const row = (b: Bot, i: number) => {
    const un = isUnreadBot(b)
    const wait = waiting.get(b.id) ?? 0
    const working = b.status === 'streaming' || busy.has(b.id)
    return (
      <a
        key={b.id}
        href={`#/s/${b.id}`}
        style={{ ...vtName(b.id), ...stagger(i) }}
        aria-current={b.id === activeId ? 'page' : undefined}
        className="vt-row row-in pressable mx-2 flex min-h-[60px] items-center gap-3 rounded-xl px-2.5 py-2 outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"
      >
        <span className={`relative shrink-0 ${working ? 'avatar-working' : ''}`}>
          <BotAvatar id={b.id} className="size-10" />
          {working && <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-2 border-background bg-emerald-500" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 truncate text-[15px] ${un ? 'font-semibold' : 'font-medium'}`}>{b.name}</span>
            <span className={`shrink-0 text-xs tabular-nums ${un ? 'text-primary' : 'text-muted-foreground'}`}>{fmtShort(b.updatedAt)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${un ? 'text-foreground' : 'text-muted-foreground'}`}>
              {b.status === 'streaming' ? <span className="shimmer">正在回复…</span> : b.last ? `${b.lastRole === 'user' ? '我：' : ''}${plain(b.last)}` : b.description || '还没有对话'}
            </span>
            {wait > 0 ? (
              <span className="attention inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400" title={`${wait} 个审批等你处理`}>
                <ShieldAlertIcon className="size-3" />
                待批准{wait > 1 ? ` ${wait}` : ''}
              </span>
            ) : working ? (
              <span className="sr-only">运行中</span>
            ) : (
              un && <span className="dot-in size-2.5 shrink-0 rounded-full bg-primary" aria-label="未读" />
            )}
          </div>
        </div>
      </a>
    )
  }

  const sessionRow = (s: SessionSummary, i: number) => (
    <a
      key={s.id}
      href={`#/s/${s.id}`}
      style={{ ...vtName(s.id), ...stagger(i) }}
      aria-current={s.id === activeId ? 'page' : undefined}
      title={s.id.startsWith('pm-') ? undefined : '在终端用 pi 开的会话'}
      className="vt-row row-in pressable mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"
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
  )

  const fold = (title: string, n: number, children: ReactNode) =>
    n > 0 && (
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-1 rounded-md text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRightIcon className="size-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" />
          {title}（{n}）
        </CollapsibleTrigger>
        <CollapsibleContent className="collapsible-anim">{children}</CollapsibleContent>
      </Collapsible>
    )

  // Searching one tab while the other has the hits: point there.
  const otherHits = tab === 'bots' ? nSessions : nBots
  const elsewhere = ql && otherHits > 0 && (
    <button type="button" onClick={() => setTab(tab === 'bots' ? 'sessions' : 'bots')} className="pressable mx-auto mt-3 flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm text-primary hover:bg-primary/10">
      「{tab === 'bots' ? '会话' : 'Bot'}」里有 {otherHits} 个结果 <ArrowRightIcon className="size-4" />
    </button>
  )
  const noHits = (
    <div className="row-in px-6 py-10 text-center text-sm text-muted-foreground">
      <p>没有匹配「{q.trim()}」的{tab === 'bots' ? ' Bot' : '会话'}</p>
      {elsewhere}
    </div>
  )

  const botsPanel =
    bots === null ? (
      <div className="space-y-2 px-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[60px] rounded-xl" />)}</div>
    ) : nBots === 0 && ql ? (
      noHits
    ) : nBots === 0 ? (
      <div className="row-in flex flex-col items-center px-6 pt-10 pb-6 text-center">
        <div className="empty-stack relative mb-5 h-16 w-28" aria-hidden>
          {['pimu-a', 'pimu-sample-2', 'pimu-c'].map((id, i) => (
            <span key={id} className="absolute top-2 rounded-full border-4 border-background shadow-soft lg:border-sidebar" style={{ left: `${i * 26}px`, '--i': i } as CSSProperties}>
              <BotAvatar id={id} className="size-12" />
            </span>
          ))}
        </div>
        <p className="font-heading text-base font-semibold">还没有 Bot</p>
        <p className="mt-1.5 max-w-64 text-sm text-pretty text-muted-foreground">Bot 是常驻的会话：有名字和人设，能定时干活、需要时找你审批。</p>
        <ol className="mt-4 w-full max-w-64 space-y-1.5 rounded-xl border bg-card/60 p-3 text-left text-[13px] text-muted-foreground">
          {['打开任一会话', '点右上角 ⋯', '选「设为 Bot」'].map((t, i) => (
            <li key={t} className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary tabular-nums">{i + 1}</span>
              {t}
            </li>
          ))}
        </ol>
        <div className="mt-5 flex gap-2">
          <Button variant="outline" className="h-11 lg:h-9" onClick={() => setTab('sessions')}>
            去「会话」挑一个
          </Button>
          <Button className="h-11 lg:h-9" onClick={() => openNewSession()}>
            <PlusIcon /> 新会话
          </Button>
        </div>
      </div>
    ) : (
      <>
        {runs.length > 0 && !ql && (
          <section aria-label="正在进行" className="row-in mx-3 mb-2 overflow-hidden rounded-xl border bg-card shadow-soft">
            <h2 className="flex items-center gap-1.5 px-3 pt-2 text-xs font-medium text-muted-foreground">
              <span className="live-dot" aria-hidden /> 正在进行
            </h2>
            {runs.map((r) => {
              const b = r.sessionId ? byId.get(r.sessionId) : undefined
              return (
                <a key={r.id} href={r.sessionId ? `#/s/${r.sessionId}` : `#/tasks/${r.taskId}`} className="flex min-h-11 items-center gap-2 px-3 py-2 outline-none hover:bg-muted/60 focus-visible:bg-muted/60">
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
        {active.length === 0 && archived.length > 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Bot 都归档了</p>}
        <div className="space-y-0.5">{active.map(row)}</div>
        {archived.length > 0 && <div className="mx-4 mt-3">{fold('已归档', archived.length, <div className="-mx-4">{archived.map(row)}</div>)}</div>}
        {ql && active.length + archived.length > 0 && elsewhere}
      </>
    )

  let n = 0
  const sessionsPanel =
    sessions === null ? (
      <div className="space-y-2 px-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11" />)}</div>
    ) : nSessions === 0 && ql ? (
      noHits
    ) : nSessions === 0 ? (
      <div className="row-in flex flex-col items-center px-6 pt-12 text-center">
        <span className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-soft">
          <SquarePenIcon className="size-5 text-muted-foreground" />
        </span>
        <p className="font-heading text-base font-semibold">还没有会话</p>
        <p className="mt-1.5 max-w-64 text-sm text-muted-foreground">选个工作目录开聊；常用的可以设为 Bot，放到「Bot」标签页。</p>
        <Button className="mt-5 h-11 lg:h-9" onClick={() => openNewSession()}>
          <PlusIcon /> 新会话
        </Button>
      </div>
    ) : (
      <>
        {groups.map((g, gi) => {
          const shown = more[g.cwd] ? g.list : g.list.slice(0, PAGE)
          return (
            <section key={g.cwd} aria-label={dirLabel(g.cwd)} className={gi ? 'mt-4' : ''}>
              <h2 className="group/dir flex h-8 items-center gap-1.5 pr-2 pl-4 text-xs font-medium text-muted-foreground" title={g.cwd}>
                <FolderIcon className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{dirLabel(g.cwd)}</span>
                {g.list.length > 1 && <span className="tabular-nums opacity-60 group-hover/dir:hidden">{g.list.length}</span>}
                <button
                  type="button"
                  className="hidden size-7 items-center justify-center rounded-md hover:bg-foreground/[0.06] hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring group-hover/dir:flex outline-none"
                  aria-label={`在 ${dirLabel(g.cwd)} 新建会话`}
                  title="在这个目录新建会话"
                  onClick={() => openNewSession(g.cwd)}
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </h2>
              {shown.map((s) => sessionRow(s, n++))}
              {g.list.length > PAGE && !more[g.cwd] && (
                <button type="button" className="mx-4 min-h-9 rounded text-xs text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setMore((m) => ({ ...m, [g.cwd]: true }))}>
                  再显示 {g.list.length - PAGE} 个
                </button>
              )}
            </section>
          )
        })}
        {elsewhere}
      </>
    )

  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const t: Tab = tab === 'bots' ? 'sessions' : 'bots'
    setTab(t)
    tabRefs.current[t]?.focus()
  }
  const count = (t: Tab) => (t === 'bots' ? (unreadBots > 0 && tab !== 'bots' ? unreadBots : nBots) : nSessions)

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-0.5 pr-2 pl-4 pt-[env(safe-area-inset-top)] box-content">
        <h1 className="flex flex-1 items-center gap-2 font-heading text-[17px] font-semibold tracking-tight">
          <span className="brand-mark" aria-hidden />
          Pimu
        </h1>
        <Button asChild size="icon" variant={route === 'inbox' ? 'secondary' : 'ghost'} className="relative size-11 lg:size-9">
          <a href="#/inbox" aria-label={unread ? `收件箱（${unread} 条未读）` : '收件箱'} title="收件箱">
            <BellIcon className={unread > 0 ? 'bell-ring' : ''} />
            {unread > 0 && <span className="dot-in absolute top-1 right-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">{unread > 99 ? '99+' : unread}</span>}
          </a>
        </Button>
        <Button size="icon" variant="ghost" className="size-11 lg:size-9" aria-label="新会话" title="新会话" onClick={() => openNewSession()}>
          <SquarePenIcon />
        </Button>
      </header>
      <div role="tablist" aria-label="列表" className="relative mx-3 mb-2 grid shrink-0 grid-cols-2 rounded-[11px] bg-foreground/[0.055] p-[3px]" onKeyDown={onTabKey}>
        <span aria-hidden className="seg-pill absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-lg bg-background shadow-[0_1px_2px_oklch(0_0_0/10%),0_2px_8px_-2px_oklch(0_0_0/10%)] dark:bg-foreground/[0.11]" style={{ transform: tab === 'sessions' ? 'translateX(100%)' : undefined }} />
        {TABS.map(([t, label]) => {
          const on = tab === t
          const c = count(t)
          const hot = t === 'bots' && tab !== 'bots' && unreadBots > 0
          return (
            <button
              key={t}
              ref={(el) => void (tabRefs.current[t] = el)}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-selected={on}
              aria-controls="sidebar-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(t)}
              className={`relative z-10 flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring lg:h-8 ${on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
              {(bots !== null || t === 'sessions') && c > 0 && (
                <span key={`${c}-${bump === t}`} className={`min-w-[1.25rem] rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums ${hot ? 'bg-primary text-primary-foreground' : 'bg-foreground/[0.07] text-muted-foreground'} ${bump === t ? 'count-bump' : ''}`}>
                  {c > 99 ? '99+' : c}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="relative shrink-0 px-3 pb-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-[calc(50%+4px)] text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          placeholder={tab === 'bots' ? '搜索 Bot' : '搜索会话'}
          className="h-11 rounded-lg border-transparent bg-foreground/[0.05] pr-9 pl-9 text-base shadow-none lg:h-9 lg:text-sm"
          aria-label={tab === 'bots' ? '搜索 Bot' : '搜索会话'}
        />
        {q ? (
          <button type="button" aria-label="清除搜索" onClick={() => setQ('')} className="absolute top-1/2 right-4 flex size-8 -translate-y-[calc(50%+4px)] items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <XIcon className="size-4" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-6 hidden -translate-y-[calc(50%+4px)] rounded border px-1.5 font-mono text-[10px] text-muted-foreground lg:block">⌘K</kbd>
        )}
      </div>
      <ScrollArea className="flex-1">
        <nav id="sidebar-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} key={tab} className={`pt-1 pb-3 ${dir === null ? 'no-anim' : dir === 'r' ? 'panel-in-r' : 'panel-in-l'}`}>
          {tab === 'bots' ? botsPanel : sessionsPanel}
        </nav>
      </ScrollArea>
      <footer className="flex shrink-0 gap-1 border-t px-2 py-1.5 pb-[max(env(safe-area-inset-bottom),0.375rem)]">
        {(
          [
            ['#/tasks', '任务', CalendarClockIcon, route === 'tasks' || route === 'task'],
            ['#/settings', '设置', SettingsIcon, route === 'settings'],
          ] as const
        ).map(([href, label, Icon, on]) => (
          <a key={href} href={href} aria-current={on ? 'page' : undefined} className="pressable flex h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground lg:h-9">
            <Icon className="size-4" /> {label}
          </a>
        ))}
      </footer>
    </div>
  )
}
