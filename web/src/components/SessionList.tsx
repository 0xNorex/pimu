import { useEffect, useMemo, useState } from 'react'
import { ChevronRightIcon, LogOutIcon, PlusIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import { go } from '@/lib/route'
import type { SessionSummary } from '@/lib/types'
import { NewSessionDialog } from './NewSessionDialog'

const STATUS: Record<SessionSummary['status'], string | null> = { idle: null, running: '运行中', streaming: '生成中', external: '终端占用' }

export function SessionList({ activeId }: { activeId?: string }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [q, setQ] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  useEffect(() => {
    const load = () => api<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => setSessions(r.sessions)).catch(() => {})
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 5000)
    return () => clearInterval(t)
  }, [])

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
