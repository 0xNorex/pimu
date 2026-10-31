import { memo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertCircleIcon, BrainIcon, ChevronRightIcon, FileIcon, LayersIcon, RotateCcwIcon, SparklesIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToolCallRow, type ToolView } from './ToolCallRow'
import type { Item } from '@/lib/timeline'
import { Button } from '@/components/ui/button'

const remark = [remarkGfm]

const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="prose-pimu">
      <Markdown remarkPlugins={remark}>{text}</Markdown>
    </div>
  )
})

function ThinkingBlock({ text, live, expand }: { text: string; live: boolean; expand: boolean }) {
  return (
    <Collapsible defaultOpen={expand}>
      <CollapsibleTrigger className="group flex min-h-7 w-full items-center gap-2 rounded-md px-1 text-left text-[13px] text-muted-foreground hover:bg-muted/60">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        <BrainIcon className="size-3.5" />
        <span className={live ? 'shimmer' : undefined}>{live ? '思考中' : '思考'} · {text.length} 字</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mb-1 ml-2 whitespace-pre-wrap border-l-2 pl-3 text-[13px] text-muted-foreground">{text}</CollapsibleContent>
    </Collapsible>
  )
}

function ToolGroup({ tools, expand }: { tools: ToolView[]; expand: boolean }) {
  const hasError = tools.some((t) => t.status === 'error')
  const running = tools.some((t) => t.status === 'running')
  const [open, setOpen] = useState(() => hasError || expand)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-7 w-full items-center gap-2 rounded-md px-1 text-left text-[13px] text-muted-foreground hover:bg-muted/60">
        <ChevronRightIcon className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        <LayersIcon className="size-3.5" />
        {tools.length} 个操作{running ? ' · 运行中' : ''}
        {hasError && <span className="text-destructive">· 有失败</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-4">
        {tools.map((t) => (
          <ToolCallRow key={t.call.id} tool={t} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

// The composer appends uploaded files as "附件（…）：\n- name: path" lines; show them as chips.
const ATTACH = /\n*附件（已保存[^\n]*\n((?:- .+(?:\n|$))+)$/
function splitAttachments(text: string) {
  const m = text.match(ATTACH)
  if (!m) return { body: text, files: [] }
  const files = m[1].trim().split('\n').map((l) => {
    const [name, ...rest] = l.slice(2).split(': ')
    return { name, path: rest.join(': ') }
  })
  return { body: text.slice(0, m.index).replace(/^请看附件。$/, ''), files }
}

// expand: the user asked to see this reply's work, so open its rows.
// onRetry re-sends the last request; onJob opens a background job.
export function MessageItem({ item, expand = false, onRetry, onJob }: { item: Item; expand?: boolean; onRetry?: () => void; onJob?: (id: number) => void }) {
  switch (item.kind) {
    case 'user': {
      const { body, files } = splitAttachments(item.text)
      return (
        <div className="flex justify-end">
          <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1.5">
            {item.images.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {item.images.map((im, i) => (
                  <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="图片" className="max-h-48 max-w-full rounded-2xl border object-cover shadow-soft" />
                ))}
              </div>
            )}
            {body && <div className="rounded-[calc(var(--radius)*1.66)] rounded-br-md bg-bubble px-3.5 py-2 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] text-bubble-foreground shadow-soft">{body}</div>}
            {files.map((f) => (
              <div key={f.path} title={f.path} className="flex max-w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm shadow-soft">
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    case 'text':
      return (
        <div className={item.live ? 'streaming-cursor' : undefined}>
          <Md text={item.text} />
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={item.text} live={item.live} expand={expand} />
    case 'tool':
      return <ToolCallRow tool={item.tool} />
    case 'group':
      return <ToolGroup tools={item.tools} expand={expand} />
    case 'aborted':
      return <p className="text-xs text-muted-foreground">已停止</p>
    case 'compaction':
      return (
        <div role="separator" className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
          <span className="h-px flex-1 bg-border" />
          已整理上下文
          <span className="h-px flex-1 bg-border" />
        </div>
      )
    case 'notice': {
      const bad = item.verb !== '完成'
      return (
        <button type="button" onClick={() => onJob?.(item.jobId)} className="pressable mx-auto flex max-w-[85%] items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-[13px] text-muted-foreground shadow-soft hover:text-foreground" data-notice={item.jobId}>
          <SparklesIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            后台「{item.title}」{bad ? (item.verb === '取消' ? '已取消' : '停下了') : '完成了'}
          </span>
          <span className="shrink-0 text-primary">{bad ? '查看' : '查看结果'}</span>
        </button>
      )
    }
    case 'error':
      return (
        <div className="flex items-start gap-2 text-sm" role="alert">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p>{humanError(item.text)}</p>
            <div className="flex items-start gap-3">
              {onRetry && (
                <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={onRetry}>
                  <RotateCcwIcon /> 重试
                </Button>
              )}
              <details className="min-w-0 pt-1.5 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">详情</summary>
                <pre className="mt-1 max-h-40 overflow-auto font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</pre>
              </details>
            </div>
          </div>
        </div>
      )
  }
}

// One human sentence per kind of failure; the raw text stays behind 详情.
export function humanError(text: string): string {
  const t = text.toLowerCase()
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api key/.test(t)) return '模型服务拒绝了请求，可能是密钥失效。'
  if (/\b429\b|rate limit|too many requests|quota|insufficient/.test(t)) return '模型服务现在太忙或额度用完了，稍后再试。'
  if (/context|maximum.*tokens|too long|token limit/.test(t)) return '对话太长了，输入 /compact 整理一下再试。'
  if (/\b5\d\d\b|timeout|timed out|econn|network|fetch failed|socket|overloaded|unavailable/.test(t)) return '连不上模型服务，等一下再试。'
  return '这次没有成功。'
}
