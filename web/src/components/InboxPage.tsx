import { useCallback, useEffect, useState } from 'react'
import { CheckCheckIcon, CheckIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, errMsg } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import type { InboxItem } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { PageHeader } from './PageHeader'

const KIND = { notify: '通知', ask: '提问', approval: '审批' } as const
const STATUS: Record<string, string> = { approved: '已批准', denied: '已拒绝', used: '已执行', expired: '已过期' }

// What the bots' heartbeats want you to see or decide. Decisions feed the next beat.
export function InboxPage({ bot }: { bot?: string }) {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [open, setOpen] = useState(true)
  const load = useCallback(() => {
    const q = new URLSearchParams({ ...(bot ? { bot } : {}), ...(open ? { open: '1' } : {}) })
    api<{ items: InboxItem[] }>(`/api/inbox?${q}`).then((r) => setItems(r.items)).catch((e) => toast.error(errMsg(e)))
  }, [bot, open])
  useEffect(load, [load])
  useGlobalEvents((e) => (e.type === 'inbox' || e.type === 'resync') && load())

  const readAll = async () => {
    try {
      await api('/api/inbox/read-all', {})
      load()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const list = (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div className="flex items-center gap-2">
        <Tabs value={open ? 'open' : 'all'} onValueChange={(v) => setOpen(v === 'open')} className="flex-1">
          <TabsList>
            <TabsTrigger value="open">待处理</TabsTrigger>
            <TabsTrigger value="all">全部</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="sm" className="min-h-9" onClick={() => void readAll()}>
          <CheckCheckIcon /> 全部已读
        </Button>
      </div>
      {!items && [0, 1].map((i) => <Skeleton key={i} className="h-28" />)}
      {items?.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">{open ? '没有待处理的事。Bot 有重要发现或需要你点头时会出现在这里。' : '还没有消息'}</p>}
      {items?.map((it) => <Row key={it.id} it={it} done={load} showBot={!bot} />)}
    </div>
  )
  if (bot) return <div className="p-4">{list}</div>
  return (
    <main className="page-in flex min-w-0 flex-1 flex-col">
      <PageHeader title="收件箱" back="#/" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">{list}</div>
    </main>
  )
}

function Row({ it, done, showBot }: { it: InboxItem; done: () => void; showBot: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (action: 'read' | 'approve' | 'deny' | 'answer') => {
    setBusy(true)
    try {
      await api(`/api/inbox/${it.id}`, { action, text })
      if (action !== 'read') toast.success(action === 'deny' ? '已拒绝' : '已记下，下次心跳会处理')
      done()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const pending = it.status === 'new' || it.status === 'read'
  const decide = pending && (it.kind === 'approval' || (it.kind === 'ask' && it.tool === 'task'))
  const answer = pending && it.kind === 'ask' && it.tool !== 'task'
  return (
    <Card className={`gap-2 py-3 ${it.status === 'new' ? '' : 'opacity-80'}`}>
      <CardContent className="space-y-2 px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant={it.kind === 'notify' ? 'secondary' : 'default'}>{it.tool === 'task' ? '子任务' : KIND[it.kind]}</Badge>
          {showBot && (
            <a href={`#/s/${it.botId}`} className="font-medium text-foreground hover:underline">
              {it.botName}
            </a>
          )}
          <span className="truncate">{it.goalTitle}</span>
          <span className="ml-auto">{fmtDate(it.createdAt)}</span>
          {it.status === 'new' && <span className="size-2 rounded-full bg-primary" aria-label="未读" />}
          {STATUS[it.status] && <Badge variant="outline">{STATUS[it.status]}</Badge>}
        </div>
        <p className="text-[15px] font-medium break-words">{it.title}</p>
        {it.body && <p className={`line-clamp-6 text-sm break-words whitespace-pre-wrap text-muted-foreground ${it.kind === 'approval' ? 'rounded-md bg-muted p-2 font-mono text-xs' : ''}`}>{it.body}</p>}
        {answer && <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="回答它…" rows={2} />}
        {(decide || answer || it.status === 'new') && (
          <div className="flex flex-wrap justify-end gap-2">
            {it.status === 'new' && !decide && !answer && (
              <Button variant="ghost" size="sm" className="min-h-9" disabled={busy} onClick={() => void act('read')}>
                已读
              </Button>
            )}
            {(decide || answer) && (
              <Button variant="outline" size="sm" className="min-h-9" disabled={busy} onClick={() => void act('deny')}>
                <XIcon /> {answer ? '忽略' : '拒绝'}
              </Button>
            )}
            {decide && (
              <Button size="sm" className="min-h-9" disabled={busy} onClick={() => void act('approve')}>
                <CheckIcon /> {it.tool === 'task' ? '批准运行' : '批准一次'}
              </Button>
            )}
            {answer && (
              <Button size="sm" className="min-h-9" disabled={busy || !text.trim()} onClick={() => void act('answer')}>
                回答
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
