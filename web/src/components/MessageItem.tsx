import { memo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertCircleIcon, BrainIcon, ChevronRightIcon, FileIcon, LayersIcon } from 'lucide-react'
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

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-7 w-full items-center gap-2 rounded-md px-1 text-left text-[13px] text-muted-foreground hover:bg-muted/60">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        <BrainIcon className="size-3.5" />
        <span className={live ? 'shimmer' : undefined}>{live ? '思考中' : '思考'} · {text.length} 字</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mb-1 ml-2 whitespace-pre-wrap border-l-2 pl-3 text-[13px] text-muted-foreground">{text}</CollapsibleContent>
    </Collapsible>
  )
}

function ToolGroup({ tools }: { tools: ToolView[] }) {
  const hasError = tools.some((t) => t.status === 'error')
  const running = tools.some((t) => t.status === 'running')
  const [open, setOpen] = useState(hasError)
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

export function MessageItem({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user': {
      const { body, files } = splitAttachments(item.text)
      return (
        <div className="flex justify-end">
          <div className="flex max-w-[85%] flex-col items-end gap-1.5">
            {item.images.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {item.images.map((im, i) => (
                  <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="图片" className="max-h-48 max-w-full rounded-2xl border object-cover shadow-soft" />
                ))}
              </div>
            )}
            {body && <div className="rounded-[20px] rounded-br-md bg-bubble px-3.5 py-2 break-words whitespace-pre-wrap text-bubble-foreground shadow-soft">{body}</div>}
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
      return <ThinkingBlock text={item.text} live={item.live} />
    case 'tool':
      return <ToolCallRow tool={item.tool} />
    case 'group':
      return <ToolGroup tools={item.tools} />
    case 'aborted':
      return <p className="text-xs text-muted-foreground">已停止</p>
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <ErrorText text={item.text} />
        </div>
      )
  }
}

// Provider errors are often "502 {json…}"; lead with the human part, keep the raw text one click away.
function ErrorText({ text }: { text: string }) {
  const m = /^(\d{3})\s+(\{[\s\S]*\})\s*$/.exec(text.trim())
  let short = ''
  if (m) {
    try {
      const j = JSON.parse(m[2])
      const msg = j?.error?.message ?? j?.message ?? j?.detail ?? j?.title ?? j?.error
      if (typeof msg === 'string') short = `${m[1]} · ${msg}`
    } catch {
      /* not JSON */
    }
  }
  if (!short) return <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
  return (
    <div className="min-w-0 space-y-1">
      <p className="[overflow-wrap:anywhere]">{short}</p>
      <details className="text-xs text-destructive/80">
        <summary className="cursor-pointer select-none">原始信息</summary>
        <pre className="mt-1 max-h-40 overflow-auto font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
      </details>
    </div>
  )
}
