import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { ArrowUpIcon, CornerDownRightIcon, FileIcon, Loader2Icon, MicIcon, PaperclipIcon, SquareIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, errMsg } from '@/lib/api'
import { BUILTINS, parseBuiltin } from '@/lib/slash'
import { getPrefs } from '@/lib/prefs'

type Image = { type: 'image'; data: string; mimeType: string }
type Att = { key: string; file: File; url?: string; path?: string; busy?: boolean }

const IMAGE_MAX = 10 << 20
const isImage = (f: File) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type)
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`)

const toBase64 = (f: File) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(f)
  })

// Web Speech API (Chrome, Edge, Safari 14.1+); the mic button is hidden when absent.
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
const SpeechRecognition = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition

type Command = { name: string; description?: string; source?: string }
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

type Props = {
  sessionId: string
  name?: string
  visionOk: boolean
  streaming: boolean
  disabled: boolean
  queued: number
  onSend: (text: string, behavior?: 'steer' | 'followUp', images?: Image[]) => Promise<boolean>
  onCommand: (name: string, arg: string) => Promise<boolean>
  onAbort: () => void
}

export function Composer({ sessionId, name, visionOk, streaming, disabled, queued, onSend, onCommand, onAbort }: Props) {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Att[]>([])
  const [listening, setListening] = useState(false)
  const [dragging, setDragging] = useState(false)
  const rec = useRef<Recognition | null>(null)
  const picker = useRef<HTMLInputElement>(null)
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

  const all: Command[] = [...BUILTINS.map(([name, description]) => ({ name, description, source: 'Pimu' })), ...(commands ?? [])]
  const matches = slash === null ? [] : all.filter((c) => c.name.startsWith(slash)).slice(0, 10)

  // Images go to the model natively (prompt images); other files are uploaded
  // to the bot's folder and their path is mentioned so pi reads them itself.
  const add = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random()}`
      if (isImage(file)) {
        if (file.size > IMAGE_MAX) {
          toast.error(`${file.name} 超过 10 MB`)
          continue
        }
        setAtts((a) => [...a, { key, file, url: URL.createObjectURL(file) }])
        continue
      }
      setAtts((a) => [...a, { key, file, busy: true }])
      const fd = new FormData()
      fd.append('file', file)
      fetch(`/api/sessions/${sessionId}/files`, { method: 'POST', body: fd, headers: { 'X-Pimu-Upload': '1' }, credentials: 'same-origin' })
        .then(async (r) => {
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.message || `上传失败（${r.status}）`)
          setAtts((a) => a.map((x) => (x.key === key ? { ...x, busy: false, path: d.path } : x)))
        })
        .catch((e) => {
          toast.error(`${file.name}：${errMsg(e)}`)
          setAtts((a) => a.filter((x) => x.key !== key))
        })
    }
  }
  const remove = (key: string) =>
    setAtts((a) => {
      const x = a.find((y) => y.key === key)
      if (x?.url) URL.revokeObjectURL(x.url)
      return a.filter((y) => y.key !== key)
    })

  const uploading = atts.some((a) => a.busy)
  const canSend = !disabled && !uploading && (!!text.trim() || atts.length > 0)

  const send = async (behavior?: 'steer' | 'followUp') => {
    if (!canSend) return
    const cmd = atts.length ? null : parseBuiltin(text)
    if (cmd) {
      if (await onCommand(cmd[0], cmd[1])) setText('')
      return
    }
    rec.current?.stop()
    const files = atts.filter((a) => a.path)
    let t = text.trim() || (atts.length ? '请看附件。' : '')
    if (files.length) t += `\n\n附件（已保存，可用 read 等工具读取）：\n${files.map((a) => `- ${a.file.name}: ${a.path}`).join('\n')}`
    let images: Image[] | undefined
    try {
      const imgs = atts.filter((a) => a.url)
      if (imgs.length) images = await Promise.all(imgs.map(async (a) => ({ type: 'image' as const, data: await toBase64(a.file), mimeType: a.file.type })))
    } catch (e) {
      toast.error(errMsg(e))
      return
    }
    // Clear right away, not after the request: anything typed while it is in
    // flight (the next follow-up, a steer) must survive, and a second Enter
    // must not send the same text twice. Put it back if the send failed.
    const sent = { text, atts }
    setText('')
    setAtts([])
    ref.current?.focus()
    if (await onSend(t, behavior, images)) sent.atts.forEach((a) => a.url && URL.revokeObjectURL(a.url))
    else {
      setText((cur) => cur || sent.text)
      setAtts((cur) => (cur.length ? cur : sent.atts))
    }
  }

  const mic = () => {
    if (listening) {
      rec.current?.stop()
      return
    }
    if (!SpeechRecognition) return
    const r = new SpeechRecognition()
    r.lang = 'zh-CN'
    r.continuous = true
    r.interimResults = true
    const base = text ? `${text} ` : ''
    r.onresult = (e) => {
      let said = ''
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript
      setText(base + said)
    }
    r.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') toast.error(e.error === 'not-allowed' ? '没有麦克风权限' : `语音识别出错：${e.error}`)
    }
    r.onend = () => setListening(false)
    rec.current = r
    try {
      r.start()
      setListening(true)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  useEffect(() => () => rec.current?.stop(), [])

  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      add(e.clipboardData.files)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!disabled && e.dataTransfer.files.length) add(e.dataTransfer.files)
  }

  const onKey = (e: KeyboardEvent) => {
    // Enter sends (Shift+Enter: newline), or with sendKey=mod only ⌘/Ctrl+Enter sends.
    const mod = getPrefs().sendKey === 'mod'
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing && (!mod || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send(streaming ? 'followUp' : undefined)
    }
  }

  return (
    <div
      className="mx-auto w-full max-w-(--chat-w) px-3 pt-1 pb-[max(env(safe-area-inset-bottom),10px)]"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {matches.length > 0 && (
        <ul className="msg-in mb-2 max-h-56 overflow-y-auto rounded-xl border bg-popover text-sm shadow-soft" role="listbox" aria-label="命令">
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
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
                {c.source && <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{c.source === 'Pimu' ? 'Pimu' : c.source === 'extension' ? '扩展' : c.source === 'skill' ? 'Skill' : c.source === 'prompt' ? '模板' : c.source}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {queued > 0 && <p className="mb-1 text-xs text-muted-foreground">已排队 {queued} 条消息</p>}
      {atts.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="附件">
          {atts.map((a) => (
            <div key={a.key} className="msg-in relative shrink-0">
              {a.url ? (
                <img src={a.url} alt={a.file.name} className="size-16 rounded-xl border object-cover shadow-soft" />
              ) : (
                <div className="flex h-16 w-44 items-center gap-2 rounded-xl border bg-card px-2.5 shadow-soft">
                  {a.busy ? <Loader2Icon className="size-5 shrink-0 animate-spin motion-reduce:animate-none" /> : <FileIcon className="size-5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 text-xs">
                    <span className="block truncate font-medium">{a.file.name}</span>
                    <span className="text-muted-foreground">{a.busy ? '上传中…' : fmtSize(a.file.size)}</span>
                  </span>
                </div>
              )}
              <button type="button" onClick={() => remove(a.key)} aria-label={`移除 ${a.file.name}`} className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full border bg-background shadow-sm">
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {!visionOk && atts.some((a) => a.url) && <p className="mb-1.5 text-xs text-amber-600 dark:text-amber-400">当前模型只支持文字，图片会被忽略。可在“模型与思考强度”里换一个支持图片的模型。</p>}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add(e.target.files)
          e.target.value = ''
        }}
      />
      <div className={`flex items-end gap-0.5 rounded-[calc(var(--radius)*2)] border bg-card p-1 shadow-soft transition-shadow duration-300 focus-within:shadow-(--shadow-lift) focus-within:ring-3 focus-within:ring-ring/25 ${dragging ? 'ring-2 ring-primary' : ''}`}>
        <Button size="icon" variant="ghost" className="size-11 lg:size-10 shrink-0 rounded-full text-muted-foreground" aria-label="添加图片或文件" title="添加图片或文件" onClick={() => picker.current?.click()} disabled={disabled}>
          <PaperclipIcon />
        </Button>
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? '只读' : listening ? '正在听…' : streaming ? '追加消息…' : `发消息给 ${name ?? '助手'}`}
          className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-1.5 py-2 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
          aria-label="消息"
        />
        {SpeechRecognition && (
          <Button size="icon" variant={listening ? 'destructive' : 'ghost'} className={`size-11 lg:size-10 shrink-0 rounded-full ${listening ? 'animate-pulse motion-reduce:animate-none' : 'text-muted-foreground'}`} aria-label={listening ? '停止语音输入' : '语音输入'} aria-pressed={listening} title="语音输入（中文）" onClick={mic} disabled={disabled}>
            <MicIcon />
          </Button>
        )}
        {streaming && (
          <>
            <Button size="icon" variant="ghost" className="size-11 lg:size-10 rounded-full" aria-label="引导（steer）：本轮工具执行后插入" onClick={() => void send('steer')} disabled={!canSend}>
              <CornerDownRightIcon />
            </Button>
            <Button size="icon" variant="destructive" className="size-11 lg:size-10 rounded-full" aria-label="停止" onClick={onAbort}>
              <SquareIcon />
            </Button>
          </>
        )}
        <Button size="icon" className="send-btn size-11 rounded-full lg:size-10" aria-label={streaming ? '排队发送（followUp）' : '发送'} onClick={() => void send(streaming ? 'followUp' : undefined)} disabled={!canSend}>
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  )
}
