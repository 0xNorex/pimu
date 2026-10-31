import { useEffect, useMemo, useState } from 'react'
import { CalendarClockIcon, SearchIcon, SettingsIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { go } from '@/lib/route'
import { newBot } from '@/lib/newBot'
import type { Bot } from '@/lib/types'
import { BotAvatar } from './BotAvatar'
import { SECTIONS } from '@/lib/sections'

type Hit = { key: string; label: string; sub?: string; href: string; bot?: string; run?: () => unknown }

// ⌘K / Ctrl+K: jump to a bot or a settings section. Plain Dialog + filter, no cmdk.
export function Switcher() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [bots, setBots] = useState<Bot[]>([])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (k === 'n' && !location.hash.startsWith('#/login')) {
        // ⌘N / Ctrl+N: new bot (where the browser lets the page have it; an installed PWA does)
        e.preventDefault()
        setOpen(false)
        void newBot()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  useEffect(() => {
    if (!open) return
    setQ('')
    setSel(0)
    api<{ bots: Bot[] }>('/api/bots').then((r) => setBots(r.bots.filter((b) => !b.archived))).catch(() => {})
  }, [open])

  const hits = useMemo(() => {
    const all: Hit[] = [
      ...[...bots].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((b) => ({ key: b.id, label: b.name, sub: b.description, href: `#/s/${b.id}`, bot: b.id })),
      { key: 'new', label: '新建 Bot', href: '', run: newBot },
      { key: 'tasks', label: '任务', href: '#/tasks' },
      ...SECTIONS.map(([k, l]) => ({ key: `set-${k}`, label: `设置 · ${l}`, href: `#/settings/${k}` })),
    ]
    const ql = q.trim().toLowerCase()
    return ql ? all.filter((h) => `${h.label} ${h.sub ?? ''}`.toLowerCase().includes(ql)) : all
  }, [bots, q])

  const pick = (h?: Hit) => {
    if (!h) return
    setOpen(false)
    if (h.run) void h.run()
    else go(h.href)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogTitle className="sr-only">跳转</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(hits.length, 1))
              } else if (e.key === 'Enter') pick(hits[sel])
            }}
            placeholder="跳到 Bot 或设置…"
            className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            aria-label="搜索"
          />
          <kbd className="rounded border px-1.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {hits.map((h, i) => (
            <li key={h.key} role="option" aria-selected={i === sel}>
              <button type="button" onMouseEnter={() => setSel(i)} onClick={() => pick(h)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left aria-selected:bg-muted" aria-selected={i === sel}>
                {h.bot ? <BotAvatar id={h.bot} className="size-7" /> : h.key === 'tasks' ? <CalendarClockIcon className="mx-1.5 size-4 text-muted-foreground" /> : <SettingsIcon className="mx-1.5 size-4 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate text-sm">{h.label}</span>
                {h.sub && <span className="max-w-[40%] truncate text-xs text-muted-foreground">{h.sub}</span>}
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">没有匹配</li>}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
