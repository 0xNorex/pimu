import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, CornerDownRightIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

type Command = { name: string; description?: string }
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

type Props = {
  sessionId: string
  streaming: boolean
  disabled: boolean
  queued: number
  onSend: (text: string, behavior?: 'steer' | 'followUp') => Promise<boolean>
  onAbort: () => void
}

export function Composer({ sessionId, streaming, disabled, queued, onSend, onAbort }: Props) {
  const [text, setText] = useState('')
  const [commands, setCommands] = useState<Command[] | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const slash = /^\/\S*$/.test(text) ? text.slice(1) : null

  useEffect(() => setCommands(null), [sessionId])
  useEffect(() => {
    if (slash === null || commands) return
    api<{ commands: Command[] }>(`/api/sessions/${sessionId}/commands`)
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]))
  }, [slash, commands, sessionId])

  const matches = slash === null || !commands ? [] : commands.filter((c) => c.name.startsWith(slash)).slice(0, 8)

  const send = async (behavior?: 'steer' | 'followUp') => {
    const t = text.trim()
    if (!t) return
    if (await onSend(t, behavior)) setText('')
    ref.current?.focus()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(streaming ? 'followUp' : undefined)
    }
  }

  return (
    <div className="border-t bg-background px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
      {matches.length > 0 && (
        <ul className="mb-2 max-h-56 overflow-y-auto rounded-md border bg-popover text-sm" role="listbox" aria-label="命令">
          {matches.map((c) => (
            <li key={c.name}>
              <button
                type="button"
                className="flex min-h-11 w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  setText(`/${c.name} `)
                  ref.current?.focus()
                }}
              >
                <span className="font-mono">/{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {queued > 0 && <p className="mb-1 text-xs text-muted-foreground">已排队 {queued} 条消息</p>}
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? '只读' : streaming ? '追加消息…' : '给 pi 发消息，/ 查看命令'}
          className="max-h-48 min-h-11 resize-none text-base"
          aria-label="消息"
        />
        {streaming && (
          <>
            <Button size="icon" variant="outline" className="size-11" aria-label="引导（steer）：本轮工具执行后插入" onClick={() => void send('steer')} disabled={disabled || !text.trim()}>
              <CornerDownRightIcon />
            </Button>
            <Button size="icon" variant="destructive" className="size-11" aria-label="停止" onClick={onAbort}>
              <SquareIcon />
            </Button>
          </>
        )}
        <Button size="icon" className="size-11" aria-label={streaming ? '排队发送（followUp）' : '发送'} onClick={() => void send(streaming ? 'followUp' : undefined)} disabled={disabled || !text.trim()}>
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  )
}
