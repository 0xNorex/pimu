import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDownIcon, ChevronLeftIcon, EllipsisIcon, HistoryIcon, InfoIcon, MessageSquarePlusIcon, RotateCcwIcon } from 'lucide-react'
import { haptic, usePrefs } from '@/lib/prefs'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errMsg } from '@/lib/api'
import { cleanModel, fmtDate, textOf } from '@/lib/format'
import { shape } from '@/lib/work'
import { go } from '@/lib/route'
import { initialStore, reducer } from '@/lib/store'
import { buildItems } from '@/lib/timeline'
import { markSeen } from '@/lib/seen'
import type { Bot, Model, SessionDetail } from '@/lib/types'
import { useSessionEvents } from '@/lib/useSessionEvents'
import { BotAvatar } from './BotAvatar'
import { botsChanged } from '@/lib/bus'
import { rememberDir } from '@/lib/newBot'
import { DirPicker } from './DirPicker'
import type { Topic } from '@/lib/types'
import { BotDetails } from './BotDetails'
import { resumeTopic } from './BotHistory'
import { LiveJobs, StatusLine, TurnFoot } from './Work'
import { ChatApprovals } from './ChatApprovals'
import { Composer } from './Composer'
import { ConnectionBanner } from './ConnectionBanner'
import { ExtensionDialog } from './ExtensionDialog'
import { MessageItem } from './MessageItem'

// Consecutive thinking / tool rows sit closer together than prose.
const WORK = new Set(['thinking', 'tool', 'group'])
const STEP = new Set<string | undefined>(['thinking', 'tool', 'group'])
import { ScrollArea } from '@/components/ui/scroll-area'
import { ModelPicker, modelKey } from './ModelPicker'

export function ChatView({ id }: { id: string }) {
  const [s, dispatch] = useReducer(reducer, initialStore)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [settings, setSettings] = useState(false)
  const [info, setInfo] = useState(false)
  const infoBtn = useRef<HTMLButtonElement>(null)
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  const [jobsLive, setJobsLive] = useState(0)
  const { work } = usePrefs()
  const [renaming, setRenaming] = useState(false)
  const [picking, setPicking] = useState(false)
  const [bot, setBot] = useState<Bot | null>(null)
  const [visionOk, setVisionOk] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const connected = useSessionEvents(id, dispatch, setDetail)

  // An earlier topic (详情 → 历史) reads as its bot's, without the composer.
  const topicOf = detail?.topicOf
  const [owner, setOwner] = useState<Bot | null>(null)
  const loadBot = useCallback(() => {
    api<{ bot: Bot }>(`/api/bots/${id}`).then((r) => setBot(r.bot)).catch(() => setBot(null))
  }, [id])
  useEffect(loadBot, [loadBot])
  useEffect(() => {
    if (topicOf) api<{ bot: Bot }>(`/api/bots/${topicOf}`).then((r) => setOwner(r.bot)).catch(() => {})
  }, [topicOf])
  // 新话题: the current conversation goes to 历史; the next message starts with an empty context. 撤销 brings it back.
  const newTopic = async () => {
    try {
      await api(`/api/bots/${id}/topics`, {})
      botsChanged()
      toast('已开新话题', {
        action: {
          label: '撤销',
          onClick: () => void api<{ topics: Topic[] }>(`/api/bots/${id}/topics`).then((r) => r.topics[0] && resumeTopic(id, r.topics[0].id)),
        },
      })
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    }
  }
  useEffect(() => {
    markSeen(id)
  }, [id, s.messages.length, s.streaming])

  // One lookup in pi's model list: the display name (idle sessions report only
  // provider/id) and whether it takes images (pi drops them silently otherwise).
  const [modelName, setModelName] = useState<string>()
  const curModel = detail?.state?.model
  const key = modelKey(curModel)
  useEffect(() => {
    if (!key) return
    api<{ models: Model[] }>('/api/models')
      .then((r) => {
        const m = r.models.find((x) => modelKey(x) === key) as (Model & { input?: string[] }) | undefined
        setModelName(m?.name)
        setVisionOk(!m?.input || m.input.includes('image'))
      })
      .catch(() => {})
  }, [key])

  const refreshDetail = useCallback(() => {
    api<SessionDetail>(`/api/sessions/${id}`).then(setDetail).catch(() => {})
  }, [id])
  useEffect(() => {
    if (s.procState === 'ready' && !s.streaming) refreshDetail()
  }, [s.procState, s.streaming, refreshDetail])

  const items = useMemo(() => buildItems(s.messages, s.draft, s.tools, s.streaming), [s.messages, s.draft, s.tools, s.streaming])
  // Messages present at load just fade in; ones sent afterwards get the launch animation.
  const firstN = useRef(Infinity)
  if (s.loaded && firstN.current === Infinity) firstN.current = items.length
  const entries = useMemo(() => shape(items, work, revealed, s.streaming), [items, work, revealed, s.streaming])
  const toggle = (turn: string) =>
    setRevealed((r) => {
      const n = new Set(r)
      if (n.has(turn)) n.delete(turn)
      else n.add(turn)
      return n
    })

  const onScroll = () => {
    const el = scroller.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }
  const toBottom = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  useLayoutEffect(() => {
    if (atBottom) toBottom()
  }, [entries, atBottom])

  const readOnly = s.lock === 'external'
  // A bot made with '+' has no name until its first message; then it joins the list.
  const draft = !!bot && !bot.name
  const patchBot = async (patch: Partial<Bot>) => {
    try {
      const r = await api<{ bot: Bot }>(`/api/bots/${id}`, patch, 'PATCH')
      setBot(r.bot)
      botsChanged()
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    }
  }
  const setCwd = async (cwd: string) => {
    rememberDir(cwd) // before the request: leaving the page right away must not lose it (a bad dir falls back on create)
    if (await patchBot({ cwd })) {
      refreshDetail()
      toast.success('工作目录已改', draft ? undefined : { description: '从下一个新话题起生效' })
      return true
    }
    return false
  }
  const send = async (message: string, behavior?: 'steer' | 'followUp', images?: { type: 'image'; data: string; mimeType: string }[]) => {
    try {
      await api(`/api/sessions/${id}/prompt`, { message, behavior, images })
      if (draft) (loadBot(), botsChanged())
      dispatch({ type: 'clear_exit' })
      setAtBottom(true)
      haptic()
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    }
  }
  const abort = async () => {
    try {
      const r = await api<{ steering?: string[]; followUp?: string[] }>(`/api/sessions/${id}/abort`, {})
      const cleared = [...(r.steering ?? []), ...(r.followUp ?? [])]
      if (cleared.length) toast(`已清除 ${cleared.length} 条排队消息`, { description: cleared.join('\n') })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const release = async () => {
    try {
      await api(`/api/sessions/${id}/release`, {})
      toast.success('已交给终端')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  // Built-in slash commands (lib/slash.ts); true = handled, clear the composer.
  const command = async (name: string, arg: string): Promise<boolean> => {
    const run = async <T,>(label: string, p: Promise<T>, done: (r: T) => string | [string, string]) => {
      const t = toast.loading(label)
      try {
        const out = done(await p)
        const [title, description] = typeof out === 'string' ? [out, undefined] : out
        toast.success(title, { id: t, description })
        return true
      } catch (e) {
        toast.error(errMsg(e), { id: t })
        return false
      }
    }
    const k = (n?: number) => (n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
    switch (name) {
      case 'compact':
        // No toast: a faint 已整理上下文 divider lands in the chat instead.
        return api(`/api/sessions/${id}/compact`, arg ? { customInstructions: arg } : {}).then(
          () => (dispatch({ type: 'compacted' }), refreshDetail(), true),
          (e) => (toast.error(errMsg(e)), false),
        )
      case 'session':
        return run('读取统计…', api<{ userMessages: number; assistantMessages: number; toolCalls: number; tokens: { total: number }; cost: number; contextUsage?: { tokens: number; contextWindow: number; percent: number } }>(`/api/sessions/${id}/stats`), (r) => [
          '会话统计',
          `消息 ${r.userMessages}↑ ${r.assistantMessages}↓ · 工具 ${r.toolCalls} · 累计 ${k(r.tokens.total)} tokens · $${r.cost.toFixed(3)}${r.contextUsage?.tokens != null ? ` · 上下文 ${k(r.contextUsage.tokens)} / ${k(r.contextUsage.contextWindow)}（${Math.round(r.contextUsage.percent)}%）` : ''}`,
        ])
      case 'export':
        return run('正在导出…', api<{ path: string }>(`/api/sessions/${id}/export`, arg ? { outputPath: arg } : {}), (r) => ['已导出 HTML', r.path])
      case 'copy':
        return run('复制中…', api<{ text: string | null }>(`/api/sessions/${id}/last-text`), (r) => {
          if (!r.text) throw new Error('还没有回复可复制')
          void navigator.clipboard.writeText(r.text)
          return '已复制最后一条回复'
        })
      case 'model': {
        const [provider, modelId] = arg.split('/')
        if (!arg || !modelId) {
          setSettings(true)
          return true
        }
        return api(`/api/sessions/${id}/model`, { provider, modelId }).then(
          () => (refreshDetail(), true),
          (e) => (toast.error(errMsg(e)), false),
        )
      }
      case 'thinking':
        if (!arg) {
          setSettings(true)
          return true
        }
        return run('设置思考强度…', api(`/api/sessions/${id}/thinking`, { level: arg }), () => (refreshDetail(), `思考强度：${arg}`))
      case 'name':
        if (!bot) return false
        if (!arg) return setRenaming(true), true
        return patchBot({ name: arg })
      case 'cd':
        if (!bot) return false
        if (!arg) return setPicking(true), true
        return setCwd(arg)
      case 'new':
        return bot ? newTopic() : false
      case 'resume':
        go('#/')
        return true
      case 'settings':
        go('#/settings')
        return true
      case 'reload':
        return run('重启 pi 进程…', api(`/api/sessions/${id}/release`, {}), () => '已重启，下一条消息会用新进程（重新加载扩展、Skills、MCP）')
      case 'fork':
      case 'clone':
        toast(`/${name} 需要在终端里做`, { description: `用 pi --session 打开（路径在「详情 → 高级」），然后输入 /${name}` })
        return true
    }
    return false
  }
  const reply = (reqId: string) => async (r: object) => {
    dispatch({ type: 'ui_done', id: reqId })
    await api(`/api/sessions/${id}/ui-response`, { id: reqId, ...r }).catch((e) => toast.error(errMsg(e)))
  }
  const lastUser = [...s.messages].reverse().find((m) => m.role === 'user')

  const face = bot ?? owner
  const title = face?.name || (draft ? '' : detail?.state?.sessionName || detail?.name || '对话')
  const model = detail?.state?.model?.provider !== 'unknown' ? cleanModel(detail?.state?.model?.name || modelName || detail?.state?.model?.id) : undefined

  const retry = lastUser ? () => void send(textOf(lastUser)) : undefined
  const working = s.streaming || jobsLive > 0

  return (
    <main className="page-in flex h-full min-w-0 flex-1 flex-col">
      <header className="z-10 box-content flex h-14 shrink-0 items-center gap-1 border-b border-transparent bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <Button variant="ghost" size="icon" className={`size-11 ${topicOf ? '' : 'lg:hidden'}`} aria-label="返回" onClick={() => go(topicOf ? `#/s/${topicOf}` : '#/')}>
          <ChevronLeftIcon />
        </Button>
        <button type="button" className="relative flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" ref={infoBtn} onClick={() => setInfo(true)} aria-label="详情" title="详情">
          {face && <BotAvatar id={face.id} className="size-8" />}
          {working && <span className="absolute right-1 bottom-1 size-2.5 animate-pulse rounded-full border-2 border-background bg-primary" data-working aria-label="正在工作" />}
        </button>
        {renaming && bot ? (
          <NameInput
            initial={bot.name}
            onDone={async (name) => {
              if (name && name !== bot.name && !(await patchBot({ name }))) return
              setRenaming(false)
            }}
          />
        ) : bot ? (
          <button type="button" className="min-h-11 min-w-0 truncate rounded-md px-1.5 text-left text-[15px] font-medium lg:min-h-9 hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" onClick={() => setRenaming(true)} aria-label="改名" title="点一下改名">
            {title ? (
              <span key={title} className="title-in">
                {title}
              </span>
            ) : (
              <span className="text-muted-foreground">新 Bot</span>
            )}
          </button>
        ) : (
          <span className="min-w-0 truncate px-1.5 text-[15px] font-medium">{title}</span>
        )}
        {topicOf && <span className="shrink-0 text-xs text-muted-foreground">· 以前的话题</span>}
        <span className="flex-1" />
        {bot && !draft && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-11 lg:size-9" aria-label="更多">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem className="min-h-10" onSelect={() => void newTopic()}>
                <MessageSquarePlusIcon /> 新话题
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-10" onSelect={() => setInfo(true)}>
                <HistoryIcon /> 历史与详情
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <ConnectionBanner connected={connected} lock={s.lock} />
      <div className="relative min-h-0 flex-1">
        <ScrollArea viewportRef={scroller} onScroll={onScroll} className="h-full">
          <div className="mx-auto flex max-w-(--chat-w) flex-col gap-(--msg-gap) px-4 py-4 text-(length:--chat-fs) leading-relaxed" data-work={work}>
            {!s.loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            {s.loaded && items.length === 0 && bot && (
              <div className="msg-in pt-[18vh] pb-12 text-center text-sm text-muted-foreground" data-empty>
                <BotAvatar id={bot.id} className="mx-auto size-16 opacity-90 shadow-soft" />
                {bot.name && <p className="mt-3 text-base font-medium text-foreground">{bot.name}</p>}
                {bot.description && <p className="mt-0.5">{bot.description}</p>}
              </div>
            )}
            {entries.map((e, i) => {
              if (e.kind === 'status') return <StatusLine key={e.key} text={e.text} />
              if (e.kind === 'foot') return <TurnFoot key={e.key} tools={e.tools} thinking={e.thinking} open={e.open} text={e.text} summary={e.summary} onToggle={() => toggle(e.turn)} />
              const it = e.item
              const prev = entries[i - 1]
              const step = STEP.has(it.kind) && prev?.kind === 'item' && STEP.has(prev.item.kind)
              return (
                <div key={it.key} className={`${it.kind === 'user' && items.indexOf(it) >= firstN.current ? 'msg-user' : 'msg-in'}${step ? ' -mt-2.5' : ''}`} data-work-row={WORK.has(it.kind) ? it.kind : undefined}>
                  <MessageItem item={it} expand={work !== 'full'} onRetry={it.kind === 'error' ? retry : undefined} onJob={() => setInfo(true)} />
                </div>
              )
            })}
            {s.exit && (
              <div className="flex items-start gap-2 text-sm" role="alert">
                <span className="min-w-0 flex-1">
                  它意外停下了。
                  {s.exit.stderrTail && (
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">详情</summary>
                      <pre className="mt-1 max-h-40 overflow-auto font-mono whitespace-pre-wrap">{`code ${s.exit.code}\n${s.exit.stderrTail}`}</pre>
                    </details>
                  )}
                </span>
                {retry && (
                  <Button size="sm" variant="outline" className="h-8" onClick={retry}>
                    <RotateCcwIcon /> 重试
                  </Button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
        <Button
          size="sm"
          variant="secondary"
          aria-hidden={atBottom}
          tabIndex={atBottom ? -1 : 0}
          className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-popover/90 shadow-soft backdrop-blur transition-[opacity,transform] duration-200 ${atBottom ? 'pointer-events-none translate-y-2 scale-95 opacity-0' : 'opacity-100'}`}
          onClick={() => setAtBottom(true)}
        >
          <ArrowDownIcon /> 回到最新
        </Button>
      </div>
      {bot && <LiveJobs botId={id} onOpen={() => setInfo(true)} onCount={setJobsLive} />}
      {bot && <ChatApprovals botId={id} />}
      {topicOf ? (
        <div className="mx-auto mb-[max(env(safe-area-inset-bottom),12px)] flex w-full max-w-(--chat-w) items-center gap-3 px-4 pt-2" data-topic-bar>
          <InfoIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">以前的话题{detail?.updatedAt ? ` · ${fmtDate(detail.updatedAt)}` : ''}，只读</span>
          <Button className="min-h-11 shrink-0" onClick={() => void resumeTopic(topicOf, id)}>
            继续这个话题
          </Button>
        </div>
      ) : (
      <Composer key={id} autoFocus={draft || undefined} sessionId={id} name={bot?.name || undefined} visionOk={visionOk} streaming={s.streaming} disabled={readOnly} queued={s.queue.steering.length + s.queue.followUp.length} onSend={send} onCommand={command} onAbort={abort} />
      )}
      {s.uiRequests[0] && <ExtensionDialog key={s.uiRequests[0].id} req={s.uiRequests[0]} onReply={reply(s.uiRequests[0].id)} />}
      {bot && <DirPicker open={picking} onOpenChange={setPicking} start={bot.cwd} onPick={(p) => void setCwd(p)} />}
      <BotDetails
        onClosed={() => infoBtn.current?.focus()}
        open={info}
        onOpenChange={setInfo}
        bot={bot ?? owner}
        onBot={bot ? setBot : setOwner}
        advanced={
          <div className="space-y-3">
            <Button variant="outline" className="min-h-11 w-full justify-start" disabled={readOnly} onClick={() => (setInfo(false), setSettings(true))}>
              模型与思考强度
            </Button>
            {bot && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">工作目录</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={bot.cwd} data-cwd>
                  {bot.cwd}
                </span>
                <Button variant="outline" size="sm" className="min-h-9 shrink-0" onClick={() => setPicking(true)}>
                  更改
                </Button>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {[
                ['模型', [model, detail?.state?.thinkingLevel].filter(Boolean).join(' · ')],
                ['会话 ID', id],
                ['终端打开', detail?.path ? `pi --session ${detail.path}` : '发第一条消息后可用'],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 font-mono text-xs leading-5 break-all" data-model-name={k === '模型' ? '' : undefined}>
                    {v || '—'}
                  </dd>
                </div>
              ))}
            </dl>
            <Button variant="outline" className="min-h-11 w-full justify-start" disabled={readOnly} onClick={() => void release()}>
              交给终端（释放进程和锁）
            </Button>
          </div>
        }
      />
      <ModelPicker open={settings} onOpenChange={setSettings} detail={detail} onSaved={refreshDetail} />
    </main>
  )
}

// Inline rename in the header: Enter or leaving the field saves, Esc cancels.
function NameInput({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [v, setV] = useState(initial)
  const done = useRef(false)
  const finish = (name: string) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      autoFocus
      value={v}
      maxLength={40}
      aria-label="名字"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(v.trim())
        if (e.key === 'Escape') finish('')
      }}
      className="h-9 min-w-0 flex-1 rounded-md bg-foreground/[0.05] px-2 text-base font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:max-w-80 lg:text-[15px]"
    />
  )
}
