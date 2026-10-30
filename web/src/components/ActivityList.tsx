import { CheckIcon, Loader2Icon, MinusIcon, XIcon } from 'lucide-react'
import { fmtMs, fmtTime, toolSummary } from '@/lib/format'
import type { ToolView } from './ToolCallRow'

const icon = {
  ok: <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="成功" />,
  error: <XIcon className="size-4 text-destructive" aria-label="失败" />,
  running: <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-label="运行中" />,
  pending: <MinusIcon className="size-4 text-muted-foreground" aria-label="未完成" />,
}

export function ActivityList({ items, onJump }: { items: { tool: ToolView; ts: number }[]; onJump: (toolCallId: string) => void }) {
  if (!items.length) return <p className="p-6 text-center text-sm text-muted-foreground">本会话还没有工具执行。</p>
  return (
    <ul className="divide-y">
      {items.map(({ tool, ts }) => (
        <li key={tool.call.id}>
          <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left font-mono text-[13px] hover:bg-muted/60" onClick={() => onJump(tool.call.id)}>
            <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{ts ? fmtTime(ts) : ''}</span>
            <span className="shrink-0 font-medium">{tool.call.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{toolSummary(tool.call)}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{fmtMs(tool.durationMs)}</span>
            {icon[tool.status]}
          </button>
        </li>
      ))}
    </ul>
  )
}
