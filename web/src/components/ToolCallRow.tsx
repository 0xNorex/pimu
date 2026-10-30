import { useState } from 'react'
import { CheckIcon, ChevronRightIcon, GlobeIcon, Loader2Icon, TerminalIcon, WrenchIcon, XIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fmtMs, toolSummary } from '@/lib/format'
import type { ImageBlock, TextBlock, ToolCallBlock } from '@/lib/types'

export type ToolView = {
  call: ToolCallBlock
  status: 'pending' | 'running' | 'ok' | 'error'
  content?: (TextBlock | ImageBlock)[]
  durationMs?: number
}

const MAX_LINES = 200

function ResultText({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const lines = text.split('\n')
  const cut = !all && lines.length > MAX_LINES
  return (
    <div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[13px]">
        {cut ? lines.slice(0, MAX_LINES).join('\n') : text}
      </pre>
      {cut && (
        <Button variant="link" size="sm" onClick={() => setAll(true)}>
          显示全部（{lines.length} 行）
        </Button>
      )}
    </div>
  )
}

export function Thumb({ img }: { img: ImageBlock }) {
  const src = `data:${img.mimeType};base64,${img.data}`
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="block" aria-label="查看大图">
          <img src={src} alt="工具结果缩略图" className="h-24 rounded border object-cover" />
        </button>
      </DialogTrigger>
      <DialogContent className="w-auto max-w-[95vw] p-2 sm:max-w-[95vw]">
        <DialogTitle className="sr-only">图片</DialogTitle>
        <img src={src} alt="工具结果图片" className="max-h-[85dvh] max-w-full object-contain" />
      </DialogContent>
    </Dialog>
  )
}

function StatusIcon({ status }: { status: ToolView['status'] }) {
  if (status === 'ok') return <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="成功" />
  if (status === 'error') return <XIcon className="size-4 text-destructive" aria-label="失败" />
  return <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none text-muted-foreground" aria-label="运行中" />
}

export function ToolCallRow({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState(tool.status === 'error')
  const [seenError, setSeenError] = useState(tool.status === 'error')
  if (tool.status === 'error' && !seenError) {
    setSeenError(true)
    setOpen(true)
  }
  const browser = tool.call.name.startsWith('mcp__playwright__')
  const Icon = tool.call.name === 'bash' ? TerminalIcon : browser ? GlobeIcon : WrenchIcon
  return (
    <Collapsible open={open} onOpenChange={setOpen} id={`tool-${tool.call.id}`} className="scroll-mt-16">
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-left font-mono text-[13px] hover:bg-muted/60">
        <ChevronRightIcon className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{browser ? tool.call.name.slice(17) : tool.call.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{toolSummary(tool.call)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{fmtMs(tool.durationMs)}</span>
        <StatusIcon status={tool.status} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 py-2 pl-7">
        <ResultText text={JSON.stringify(tool.call.arguments, null, 2)} />
        {tool.content?.map((b, i) =>
          b.type === 'text' ? <ResultText key={i} text={b.text} /> : <Thumb key={i} img={b} />,
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
