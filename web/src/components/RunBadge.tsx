import { Loader2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { RunStatus } from '@/lib/types'

const LABEL: Record<RunStatus, string> = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', aborted: '已中止' }

export function RunBadge({ status }: { status: RunStatus }) {
  const cls =
    status === 'succeeded'
      ? 'border-transparent bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
      : status === 'failed'
        ? 'border-transparent bg-destructive/15 text-destructive'
        : ''
  return (
    <Badge variant={status === 'queued' || status === 'aborted' ? 'outline' : 'secondary'} className={cls}>
      {status === 'running' && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
      {LABEL[status]}
    </Badge>
  )
}

export const TRIGGER: Record<string, string> = { cron: '定时', manual: '手动', retry: '重试' }
