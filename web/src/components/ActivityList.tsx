import { useState } from 'react'
import { CheckIcon, GlobeIcon, Loader2Icon, MinusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fmtMs, fmtTime, toolSummary } from '@/lib/format'
import type { ImageBlock } from '@/lib/types'
import { Thumb, type ToolView } from './ToolCallRow'

const icon = {
  ok: <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="成功" />,
  error: <XIcon className="size-4 text-destructive" aria-label="失败" />,
  running: <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-label="运行中" />,
  pending: <MinusIcon className="size-4 text-muted-foreground" aria-label="未完成" />,
}

// Browser tools come from @playwright/mcp via pi's MCP adapter (mcp__playwright__browser_*).
const BROWSER_PREFIX = 'mcp__playwright__'
export const isBrowserTool = (name: string) => name.startsWith(BROWSER_PREFIX) || name.startsWith('browser_')
const shortName = (name: string) => (name.startsWith(BROWSER_PREFIX) ? name.slice(BROWSER_PREFIX.length) : name)

export function ActivityList({ items, onJump }: { items: { tool: ToolView; ts: number }[]; onJump: (toolCallId: string) => void }) {
  const [browserOnly, setBrowserOnly] = useState(false)
  const hasBrowser = items.some((i) => isBrowserTool(i.tool.call.name))
  const shown = browserOnly ? items.filter((i) => isBrowserTool(i.tool.call.name)) : items
  if (!items.length) return <p className="p-6 text-center text-sm text-muted-foreground">本会话还没有工具执行。</p>
  return (
    <div>
      {hasBrowser && (
        <div className="flex gap-1.5 px-3 py-2" role="group" aria-label="筛选">
          <Button size="sm" variant={browserOnly ? 'outline' : 'secondary'} onClick={() => setBrowserOnly(false)} aria-pressed={!browserOnly}>
            全部 {items.length}
          </Button>
          <Button size="sm" variant={browserOnly ? 'secondary' : 'outline'} onClick={() => setBrowserOnly(true)} aria-pressed={browserOnly}>
            <GlobeIcon />
            浏览器操作
          </Button>
        </div>
      )}
      <ul className="divide-y">
        {shown.map(({ tool, ts }) => {
          const images = (tool.content ?? []).filter((b): b is ImageBlock => b.type === 'image')
          return (
            <li key={tool.call.id}>
              <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left font-mono text-[13px] hover:bg-muted/60" onClick={() => onJump(tool.call.id)}>
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{ts ? fmtTime(ts) : ''}</span>
                {isBrowserTool(tool.call.name) && <GlobeIcon className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-label="浏览器" />}
                <span className="shrink-0 font-medium">{shortName(tool.call.name)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{toolSummary(tool.call)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtMs(tool.durationMs)}</span>
                {icon[tool.status]}
              </button>
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pb-3 pl-[4.5rem]">
                  {images.map((img, i) => (
                    <Thumb key={i} img={img} />
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
