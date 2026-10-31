import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { BellIcon, CalendarClockIcon, ChevronRightIcon, Loader2Icon, PlusIcon, SearchIcon, SettingsIcon, ShieldAlertIcon, MoonIcon, SunIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { BOTS_CHANGED, transition } from '@/lib/bus'
import { fmtShort } from '@/lib/format'
import type { Route } from '@/lib/route'
import { isUnread } from '@/lib/seen'
import type { Bot, InboxItem, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { isDark, reveal } from '@/lib/prefs'
import { BotAvatar } from './BotAvatar'
import { newBot } from '@/lib/newBot'

// Previews are raw markdown; drop the syntax characters.
const plain = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim()

// Rows fade up one after another; capped so long lists don't wait.
const stagger = (i: number) => ({ '--i': Math.min(i, 12) }) as CSSProperties
// Each row has its own name so reorders animate (View Transitions).
const vtName = (id: string) => ({ viewTransitionName: `row-${id}` }) as CSSProperties

// The sidebar: just the bots. Every conversation belongs to one (助手 takes ad-hoc questions).
export function BotList({ activeId, route }: { activeId?: string; route: Route['name'] }) {
  const [bots, setBots] = useState<Bot[] | null>(null)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [waiting, setWaiting] = useState<Map<string, number>>(new Map())
  const [q, setQ] = useState('')
  const [unread, setUnread] = useState(0)

  // Animate reorders (a bot jumping to the top) with View Transitions where supported.
  const order = useRef('')
  const load = () => {
    api<{ bots: Bot[] }>('/api/bots')
      .then(({ bots: b }) => {
        const next = b.map((x) => `${x.id}:${x.status}:${x.jobsRunning ?? 0}:${x.updatedAt}`).join()
        const apply = () => flushSync(() => setBots(b))
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
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    addEventListener(BOTS_CHANGED, load)
    return () => (clearInterval(t), removeEventListener(BOTS_CHANGED, load))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useGlobalEvents(load)

  const ql = q.trim().toLowerCase()
  const match = (...s: (string | undefined)[]) => !ql || s.join(' ').toLowerCase().includes(ql)
  const byId = useMemo(() => new Map((bots ?? []).map((b) => [b.id, b])), [bots])
  const busy = useMemo(() => new Set(runs.map((r) => r.sessionId).filter(Boolean) as string[]), [runs])
  const isUnreadBot = (b: Bot) => b.id !== activeId && b.lastRole === 'assistant' && isUnread(b.id, b.updatedAt)

  // Busy first, then waiting / unread, then most recent — like a messaging app.
  const [active, archived] = useMemo(() => {
    const rank = (b: Bot) => (b.status === 'streaming' || b.jobsRunning ? 3 : waiting.has(b.id) ? 2 : isUnreadBot(b) ? 1 : 0)
    const list = (bots ?? []).filter((b) => match(b.name, b.description, b.last))
    list.sort((a, b) => rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return [list.filter((b) => !b.archived), list.filter((b) => b.archived)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, ql, activeId, waiting])
  const nBots = active.length + archived.length

  const row = (b: Bot, i: number) => {
    const un = isUnreadBot(b)
    const wait = waiting.get(b.id) ?? 0
    const working = b.status === 'streaming' || busy.has(b.id) || !!b.jobsRunning
    return (
      <a
        key={b.id}
        href={`#/s/${b.id}`}
        style={{ ...vtName(b.id), ...stagger(i) }}
        aria-current={b.id === activeId ? 'page' : undefined}
        className="vt-row row-in pressable mx-2 flex min-h-(--row-h) items-center gap-3 rounded-xl px-2.5 py-2 outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"
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
              {b.status === 'streaming' ? <span className="shimmer">正在回复…</span> : b.jobsRunning ? <span className="shimmer">在后台做事…</span> : b.last ? `${b.lastRole === 'user' ? '我：' : ''}${plain(b.last)}` : b.description || '还没有对话'}
            </span>
            {wait > 0 ? (
              <span className="attention inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400" title="等你确认">
                <ShieldAlertIcon className="size-3" />
                等你确认
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

  const noHits = <p className="row-in px-6 py-10 text-center text-sm text-muted-foreground">没有匹配「{q.trim()}」的 Bot</p>

  const botsPanel =
    bots === null ? (
      <div className="space-y-2 px-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[60px] rounded-xl" />)}</div>
    ) : nBots === 0 && ql ? (
      noHits
    ) : nBots === 0 ? (
      <div className="row-in flex flex-col items-center px-6 pt-10 pb-6 text-center">
        <p className="font-heading text-base font-semibold">还没有 Bot</p>
        <Button className="mt-4 h-11 lg:h-9" onClick={() => void newBot()}>
          <PlusIcon /> 新建 Bot
        </Button>
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
      </>
    )

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
            {unread > 0 && <span className="dot-in absolute top-2 right-2 size-2 rounded-full bg-primary" aria-hidden />}
          </a>
        </Button>
        <Button size="icon" variant="ghost" className="size-11 lg:size-9" aria-label="新建 Bot" title="新建 Bot（⌘N）" onClick={() => void newBot()}>
          <PlusIcon />
        </Button>
      </header>
      <div className="relative shrink-0 px-3 pb-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-[calc(50%+4px)] text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          placeholder="搜索 Bot"
          className="h-11 rounded-lg border-transparent bg-foreground/[0.05] pr-9 pl-9 text-base shadow-none lg:h-9 lg:text-sm"
          aria-label="搜索 Bot"
        />
        {q ? (
          <button type="button" aria-label="清除搜索" onClick={() => setQ('')} className="absolute top-1/2 right-4 flex size-8 -translate-y-[calc(50%+4px)] items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      <ScrollArea className="flex-1">
        <nav aria-label="Bot" className="pt-1 pb-3">
          {botsPanel}
        </nav>
      </ScrollArea>
      <footer className="flex shrink-0 gap-1 border-t px-2 py-1.5 pb-[max(env(safe-area-inset-bottom),0.375rem)]">
        {(
          [
            ['#/settings', '设置', SettingsIcon, route === 'settings'],
          ] as const
        ).map(([href, label, Icon, on]) => (
          <a key={href} href={href} aria-current={on ? 'page' : undefined} className="pressable flex h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground lg:h-9">
            <Icon className="size-4" /> {label}
          </a>
        ))}
        <button
          type="button"
          title="切换浅色 / 深色"
          aria-label="切换浅色 / 深色"
          onClick={(e) => reveal({ theme: isDark() ? 'light' : 'dark' }, e.currentTarget)}
          className="pressable flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:size-9"
        >
          <SunIcon className="hidden size-4 dark:block" />
          <MoonIcon className="size-4 dark:hidden" />
        </button>
      </footer>
    </div>
  )
}
