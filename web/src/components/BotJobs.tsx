import { useCallback, useEffect, useState } from 'react'
import { ChevronDownIcon, Loader2Icon, RotateCcwIcon, SendIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { api, errMsg } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import type { Job } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'

const STATUS: Record<Job['status'], [string, 'default' | 'secondary' | 'outline' | 'destructive']> = {
  queued: ['排队中', 'outline'],
  running: ['运行中', 'default'],
  waiting_approval: ['等你批准', 'default'],
  completed: ['完成', 'secondary'],
  failed: ['失败', 'destructive'],
  interrupted: ['被中断', 'destructive'],
  cancelled: ['已取消', 'outline'],
}
// From Pimu's approval records, not from what the worker says.
const approvalText = (j: Job) => {
  const a = j.approvals
  if (!a?.approval_count) return ' · 无审批'
  const parts = [`批准 ${a.approved}`, `拒绝 ${a.denied}`]
  if (a.expired) parts.push(`过期 ${a.expired}`)
  if (a.pending) parts.push(`待定 ${a.pending}`)
  return ` · 审批 ${a.approval_count}（${parts.join('，')}）`
}
const live = (j: Job) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_approval'

// Background jobs this bot delegated with pimu_task; results flow back into the chat.
export function BotJobs({ botId }: { botId: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const load = useCallback(() => void api<{ jobs: Job[] }>(`/api/bots/${botId}/jobs`).then((r) => setJobs(r.jobs)).catch(() => {}), [botId])
  useEffect(load, [load])
  useGlobalEvents((e) => ((e.type === 'job_update' && e.job.botId === botId) || e.type === 'resync') && load())

  return (
    <div className="mx-auto max-w-3xl p-4 pb-0">
      <h3 className="text-sm font-medium">后台任务</h3>
      <p className="mb-3 text-sm text-muted-foreground">在对话里让它「放到后台做」，它会用 pimu_task 派出独立会话；做完结果自动回到对话。</p>
      {jobs?.length === 0 && <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">还没有后台任务</p>}
      <ul className="divide-y rounded-lg border empty:hidden">
        {jobs?.map((j) => <Row key={j.id} j={j} reload={load} />)}
      </ul>
    </div>
  )
}

function Row({ j, reload }: { j: Job; reload: () => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const act = async (action: 'cancel' | 'steer' | 'rerun') => {
    try {
      await api(`/api/jobs/${j.id}/${action}`, { text })
      toast.success({ cancel: '已取消', steer: '已追加，会在它当前步骤之后生效', rerun: '已重新排队' }[action])
      setText('')
      reload()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const [label, variant] = STATUS[j.status]
  return (
    <li className="px-3 py-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <ChevronDownIcon className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">
                #{j.id} {j.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {fmtDate(j.createdAt)}
                {j.tokens > 0 && ` · ${Math.round(j.tokens / 1000)}k tok`}
                {j.status === 'completed' && (j.delivered ? ' · 已送回对话' : ' · 等待送回')}
                {approvalText(j)}
              </span>
            </span>
          </CollapsibleTrigger>
          <Badge variant={variant} className="shrink-0">
            {(j.status === 'running' || j.status === 'waiting_approval') && <Loader2Icon className="animate-spin" />}
            {label}
          </Badge>
          {live(j) && (
            <Button variant="ghost" size="icon" className="size-9" aria-label={`取消任务 ${j.title}`} onClick={() => void act('cancel')}>
              <XIcon />
            </Button>
          )}
        </div>
        <CollapsibleContent className="space-y-2 pt-2 pl-6 text-sm">
          {j.status === 'waiting_approval' && (
            <a href="#/inbox" className="block text-xs text-primary underline">
              它在等你批准一个操作 → 收件箱
            </a>
          )}
          {j.status === 'interrupted' && <p className="text-xs text-muted-foreground">Pimu 重启时它还在运行。不会自动重跑，由你决定：</p>}
          <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{j.prompt}</pre>
          {(j.result || j.error) && <pre className="max-h-60 overflow-auto rounded-md border p-2 text-xs whitespace-pre-wrap">{j.error ? `${j.error}\n\n` : ''}{j.result}</pre>}
          {j.sessionId && j.status !== 'queued' && (
            <a href={`#/s/${j.sessionId}`} className="block text-xs text-muted-foreground underline">
              打开它的会话
            </a>
          )}
          {(j.status === 'running' || j.status === 'waiting_approval') && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (text.trim()) void act('steer')
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="追加指示…" />
              <Button type="submit" size="icon" className="size-9 shrink-0" aria-label="发送追加指示" disabled={!text.trim()}>
                <SendIcon />
              </Button>
            </form>
          )}
          {(j.status === 'interrupted' || j.status === 'failed' || j.status === 'cancelled') && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="min-h-9" onClick={() => void act('rerun')}>
                <RotateCcwIcon /> 重新运行
              </Button>
              {j.status === 'interrupted' && (
                <Button variant="ghost" size="sm" className="min-h-9" onClick={() => void act('cancel')}>
                  丢弃
                </Button>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
