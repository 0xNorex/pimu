import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PlayIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, errMsg } from '@/lib/api'
import { cronLabel, fmtDate } from '@/lib/format'
import type { Task } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { RunBadge } from './RunBadge'

// Tasks that run inside this bot; their output lands in its conversation.
export function BotTasks({ botId }: { botId: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const load = useCallback(() => {
    api<{ tasks: Task[] }>('/api/tasks').then((r) => setTasks(r.tasks.filter((t) => t.sessionMode === 'reuse' && t.sessionId === botId))).catch(() => {})
  }, [botId])
  useEffect(load, [load])
  useGlobalEvents((e) => (e.type === 'run_update' || e.type === 'resync') && load())

  const run = async (t: Task) => {
    try {
      await api(`/api/tasks/${t.id}/run`, {})
      toast.success('已开始运行', { description: '结果会出现在对话里' })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">定时或手动让它做事，结果写进对话。</p>
        <Button asChild size="sm" className="min-h-9">
          <a href={`#/tasks/new?bot=${botId}`}>
            <PlusIcon /> 新任务
          </a>
        </Button>
      </div>
      <ul className="divide-y rounded-lg border empty:hidden">
        {tasks?.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2.5">
            <a href={`#/tasks/${t.id}`} className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-medium">{t.name}</div>
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{t.schedule ? cronLabel(t.schedule) : '仅手动'}</span>
                {t.enabled && t.nextRun && <span>下次 {fmtDate(t.nextRun)}</span>}
                {t.lastRun && (
                  <span className="flex items-center gap-1">
                    <RunBadge status={t.lastRun.status} /> {fmtDate(t.lastRun.createdAt)}
                  </span>
                )}
              </div>
            </a>
            <Button size="icon" variant="outline" className="size-11" aria-label={`立即运行 ${t.name}`} onClick={() => void run(t)}>
              <PlayIcon />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
