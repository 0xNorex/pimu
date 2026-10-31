import { useCallback, useEffect, useState } from 'react'
import { ChevronDownIcon, Loader2Icon, RotateCcwIcon, SendIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { api, errMsg } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import type { Job } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'

// Plain words for what a job is doing; no ids, tokens or state names.
export const jobLine = (j: Job) =>
  ({
    queued: `等一下就做「${j.title}」`,
    running: `正在做「${j.title}」…`,
    waiting_approval: `「${j.title}」在等你确认`,
    completed: `「${j.title}」完成了`,
    failed: `「${j.title}」没做成`,
    interrupted: `「${j.title}」停下了`,
    cancelled: `「${j.title}」已取消`,
  })[j.status]
export const jobLive = (j: Job) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_approval'
const live = jobLive

// Background jobs this bot delegated with pimu_task; results flow back into the chat.
export function BotJobs({ botId }: { botId: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const load = useCallback(() => void api<{ jobs: Job[] }>(`/api/bots/${botId}/jobs`).then((r) => setJobs(r.jobs)).catch(() => {}), [botId])
  useEffect(load, [load])
  useGlobalEvents((e) => ((e.type === 'job_update' && e.job.botId === botId) || e.type === 'resync') && load())

  return (
    <div className="space-y-2">
      {jobs?.length === 0 && <p className="text-sm text-muted-foreground">在对话里说「放到后台做」，它就会在这里慢慢做，做完把结果送回对话。</p>}
      <ul className="space-y-2 empty:hidden">
        {jobs?.slice(0, 20).map((j) => <Row key={j.id} j={j} reload={load} />)}
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
            setText('')
      reload()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <li className="rounded-xl border bg-card shadow-soft" data-job={j.status}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {live(j) ? <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <ChevronDownIcon className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />}
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[15px] ${j.status === 'running' ? 'shimmer' : ''}`}>{jobLine(j)}</span>
              <span className="block truncate text-xs text-muted-foreground">{j.status === 'completed' ? '点击查看' : fmtDate(j.finishedAt || j.createdAt)}</span>
            </span>
          </CollapsibleTrigger>
          {live(j) && (
            <Button variant="ghost" size="icon" className="size-9" aria-label={`取消任务 ${j.title}`} onClick={() => void act('cancel')}>
              <XIcon />
            </Button>
          )}
        </div>
        <CollapsibleContent className="space-y-2 px-3 pb-3 text-sm">
          {j.status === 'waiting_approval' && <p className="text-xs text-muted-foreground">在对话下方确认或拒绝。</p>}
          {j.error && <p className="text-[13px] text-muted-foreground">{j.error}</p>}
          {j.result && <div className="max-h-60 overflow-auto text-[13px] whitespace-pre-wrap">{j.result}</div>}
          {(j.status === 'running' || j.status === 'waiting_approval') && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (text.trim()) void act('steer')
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="补充一句…" />
              <Button type="submit" size="icon" className="size-9 shrink-0" aria-label="发送追加指示" disabled={!text.trim()}>
                <SendIcon />
              </Button>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(j.status === 'interrupted' || j.status === 'failed' || j.status === 'cancelled') && (
              <Button variant="outline" size="sm" className="min-h-9" onClick={() => void act('rerun')}>
                <RotateCcwIcon /> 重试
              </Button>
            )}
            {j.status === 'interrupted' && (
              <Button variant="ghost" size="sm" className="min-h-9" onClick={() => void act('cancel')}>
                丢弃
              </Button>
            )}
            <details className="w-full text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">原始指令</summary>
              <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap">{j.prompt}</pre>
              {j.sessionId && j.status !== 'queued' && (
                <a href={`#/s/${j.sessionId}`} className="mt-1 block underline">
                  打开它的会话
                </a>
              )}
            </details>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
