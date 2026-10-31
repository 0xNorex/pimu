import { useEffect, useState } from 'react'
import { CopyIcon, EllipsisIcon, ListTreeIcon } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { Job } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { jobLine, jobLive } from './BotJobs'

// The single live hint while the agent works; it goes away when the answer comes.
export function StatusLine({ text }: { text: string }) {
  return (
    <p className="msg-in text-[13px] text-muted-foreground" role="status" data-status-line>
      <span className="shimmer">{text}</span>
    </p>
  )
}

// Below each finished reply: a faint ⋯ (copy / 查看过程) and, in summary mode,
// a tiny "用了 N 个工具" that toggles the same trace.
export function TurnFoot({ tools, thinking, open, text, summary, onToggle }: { tools: number; thinking: number; open: boolean; text: string; summary: boolean; onToggle: () => void }) {
  const work = tools + thinking > 0
  if (!work && !text) return null
  const label = tools ? `用了 ${tools} 个工具` : '想了一下'
  return (
    <div className="-mt-2 flex items-center gap-1 text-xs text-muted-foreground/70" data-turn-foot>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md opacity-60 hover:bg-foreground/[0.05] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="更多操作">
          <EllipsisIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {text && (
            <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(text).then(() => toast.success('已复制'))}>
              <CopyIcon /> 复制
            </DropdownMenuItem>
          )}
          {work && (
            <DropdownMenuItem onSelect={onToggle}>
              <ListTreeIcon /> {open ? '收起过程' : '查看过程'}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {summary && work && (
        <button type="button" onClick={onToggle} className="rounded px-1 hover:text-foreground" aria-expanded={open}>
          · {label}
        </button>
      )}
    </div>
  )
}

// A bot's background work, in plain words, just above the composer.
export function LiveJobs({ botId, onOpen, onCount }: { botId: string; onOpen: () => void; onCount?: (n: number) => void }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const load = () => void api<{ jobs: Job[] }>(`/api/bots/${botId}/jobs`).then((r) => setJobs(r.jobs.filter(jobLive))).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [botId])
  useGlobalEvents((e) => ((e.type === 'job_update' && e.job.botId === botId) || e.type === 'resync') && load())
  useEffect(() => onCount?.(jobs.length), [jobs.length, onCount])
  if (!jobs.length) return null
  return (
    <div className="mx-auto flex w-full max-w-(--chat-w) flex-wrap gap-2 px-4 pb-2">
      {jobs.slice(0, 3).map((j) => (
        <button key={j.id} type="button" onClick={onOpen} className="pressable flex max-w-full items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-[13px] text-muted-foreground shadow-soft" data-live-job>
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          <span className={`truncate ${j.status === 'running' ? 'shimmer' : ''}`}>{jobLine(j)}</span>
        </button>
      ))}
      {jobs.length > 3 && <span className="self-center text-xs text-muted-foreground">还有 {jobs.length - 3} 个</span>}
    </div>
  )
}
