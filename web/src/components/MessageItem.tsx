import { memo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertCircleIcon, BrainIcon, ChevronRightIcon, LayersIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToolCallRow, type ToolView } from './ToolCallRow'
import type { Item } from '@/lib/timeline'

const remark = [remarkGfm]

const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="prose-pimu">
      <Markdown remarkPlugins={remark}>{text}</Markdown>
    </div>
  )
})

function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-11 items-center gap-2 text-[13px] text-muted-foreground">
        <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        <BrainIcon className="size-4" />
        思考 · {text.length} 字
      </CollapsibleTrigger>
      <CollapsibleContent className="whitespace-pre-wrap border-l-2 pl-3 text-[13px] text-muted-foreground">{text}</CollapsibleContent>
    </Collapsible>
  )
}

function ToolGroup({ tools }: { tools: ToolView[] }) {
  const hasError = tools.some((t) => t.status === 'error')
  const running = tools.some((t) => t.status === 'running')
  const [open, setOpen] = useState(hasError)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-left text-[13px] text-muted-foreground hover:bg-muted/60">
        <ChevronRightIcon className={`size-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        <LayersIcon className="size-4" />
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

export function MessageItem({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-3.5 py-2">{item.text}</div>
        </div>
      )
    case 'text':
      return (
        <div className={item.live ? 'streaming-cursor' : undefined}>
          <Md text={item.text} />
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={item.text} />
    case 'tool':
      return <ToolCallRow tool={item.tool} />
    case 'group':
      return <ToolGroup tools={item.tools} />
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{item.text}</span>
        </div>
      )
  }
}
