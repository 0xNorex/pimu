import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDownIcon, ChevronLeftIcon, EllipsisVerticalIcon, RotateCcwIcon } from 'lucide-react'
import { haptic } from '@/lib/theme'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errMsg } from '@/lib/api'
import { textOf } from '@/lib/format'
import { go } from '@/lib/route'
import { initialStore, reducer } from '@/lib/store'
import { buildItems, toolActivity } from '@/lib/timeline'
import { markSeen } from '@/lib/seen'
import type { Bot, Model, SessionDetail } from '@/lib/types'
import { useSessionEvents } from '@/lib/useSessionEvents'
import { ActivityList } from './ActivityList'
import { BotAvatar } from './BotAvatar'
import { BotDialog } from './BotDialog'
import { BotTasks } from './BotTasks'
import { BotGoals } from './BotGoals'
import { Composer } from './Composer'
import { ConnectionBanner } from './ConnectionBanner'
import { ExtensionDialog } from './ExtensionDialog'
import { MessageItem } from './MessageItem'
import { ModelPicker } from './ModelPicker'

function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0
}

export function ChatView({ id }: { id: string }) {
  const [s, dispatch] = useReducer(reducer, initialStore)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [tab, setTab] = useState('chat')
  const [settings, setSettings] = useState(false)
  const [info, setInfo] = useState(false)
  const [editBot, setEditBot] = useState(false)
  const [unset, setUnset] = useState(false)
  const [bot, setBot] = useState<Bot | null>(null)
  const [visionOk, setVisionOk] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const connected = useSessionEvents(id, dispatch, setDetail)
  const elapsed = useElapsed(s.streaming ? s.runStartedAt : null)

  // Idle sessions report only provider/id (read from the session file); look up the display name.
  const [modelName, setModelName] = useState<string>()
  const idleModel = detail?.state?.model && !detail.state.model.name ? `${detail.state.model.provider}/${detail.state.model.id}` : ''
  useEffect(() => {
    if (!idleModel) return
    api<{ models: Model[] }>('/api/models')
      .then((r) => setModelName(r.models.find((m) => `${m.provider}/${m.id}` === idleModel)?.name))
      .catch(() => {})
  }, [idleModel])

  const loadBot = useCallback(() => {
    api<{ bot: Bot }>(`/api/bots/${id}`).then((r) => setBot(r.bot)).catch(() => setBot(null))
  }, [id])
  useEffect(loadBot, [loadBot])
  useEffect(() => {
    markSeen(id)
  }, [id, s.messages.length, s.streaming])

  // Warn before sending images to a text-only model (pi drops them silently).
  const modelKey = detail?.state?.model ? `${detail.state.model.provider}/${detail.state.model.id}` : ''
  useEffect(() => {
    if (!modelKey) return
    api<{ models: Model[] }>('/api/models')
      .then((r) => {
        const m = r.models.find((x) => `${x.provider}/${x.id}` === modelKey) as (Model & { input?: string[] }) | undefined
        setVisionOk(!m?.input || m.input.includes('image'))
      })
      .catch(() => {})
  }, [modelKey])

  const refreshDetail = useCallback(() => {
    api<SessionDetail>(`/api/sessions/${id}`).then(setDetail).catch(() => {})
  }, [id])
  useEffect(() => {
    if (s.procState === 'ready' && !s.streaming) refreshDetail()
  }, [s.procState, s.streaming, refreshDetail])

  const items = useMemo(() => buildItems(s.messages, s.draft, s.tools, s.streaming), [s.messages, s.draft, s.tools, s.streaming])
  const activity = useMemo(() => (tab === 'activity' ? toolActivity(s.messages, s.draft, s.tools, s.streaming) : []), [tab, s.messages, s.draft, s.tools, s.streaming])

  const onScroll = () => {
    const el = scroller.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }
  const toBottom = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  useLayoutEffect(() => {
    if (atBottom) toBottom()
  }, [items, atBottom])

  const readOnly = s.lock === 'external'
  const send = async (message: string, behavior?: 'steer' | 'followUp', images?: { type: 'image'; data: string; mimeType: string }[]) => {
    try {
      await api(`/api/sessions/${id}/prompt`, { message, behavior, images })
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
      toast.success('已交给终端', { description: `pi --session ${id}` })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const reply = (reqId: string) => async (r: object) => {
    dispatch({ type: 'ui_done', id: reqId })
    await api(`/api/sessions/${id}/ui-response`, { id: reqId, ...r }).catch((e) => toast.error(errMsg(e)))
  }
  const jump = (toolCallId: string) => {
    setTab('chat')
    setAtBottom(false)
    requestAnimationFrame(() => document.getElementById(`tool-${toolCallId}`)?.scrollIntoView({ block: 'center' }))
  }
  const unsetBot = async () => {
    try {
      await api(`/api/bots/${id}`, {}, 'DELETE')
      setBot(null)
      toast.success('已取消 Bot', { description: '会话和对话都还在，回到按目录分组的会话列表里。' })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const lastUser = [...s.messages].reverse().find((m) => m.role === 'user')

  const title = bot?.name || detail?.state?.sessionName || detail?.name || '对话'
  const model = detail?.state?.model?.provider !== 'unknown' ? detail?.state?.model?.name || modelName || detail?.state?.model?.id : undefined

  return (
    <div className="page-in flex h-full min-w-0 flex-1 flex-col">
      <header className="z-10 flex items-center gap-1 border-b bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <Button variant="ghost" size="icon" className="size-11 lg:hidden" aria-label="返回" onClick={() => go('#/')}>
          <ChevronLeftIcon />
        </Button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-1 text-left" onClick={() => (bot ? setEditBot(true) : setInfo(true))} aria-label={bot ? '编辑 Bot' : '详情'}>
          {bot && <BotAvatar id={bot.id} className="size-9" />}
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-medium">{title}</span>
            <span className="block truncate text-xs text-muted-foreground" aria-live="polite">
              {s.streaming ? <span className="shimmer">正在回复… {elapsed}s</span> : bot?.description || model || ''}
            </span>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label="会话菜单">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditBot(true)}>{bot ? '编辑 Bot（名字、人设）' : '设为 Bot'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSettings(true)} disabled={readOnly}>
              模型与思考强度
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setInfo(true)}>详情</DropdownMenuItem>
            {bot && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setUnset(true)}>取消 Bot（保留会话）</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <ConnectionBanner connected={connected} lock={s.lock} />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-auto mt-2 w-fit">
          <TabsTrigger value="chat">对话</TabsTrigger>
          {bot && <TabsTrigger value="goals">目标</TabsTrigger>}
          {bot && <TabsTrigger value="tasks">任务</TabsTrigger>}
          <TabsTrigger value="activity">活动</TabsTrigger>
        </TabsList>
        <TabsContent value="chat" className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 text-[15px] leading-relaxed">
              {!s.loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
              {s.loaded && items.length === 0 && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {bot && <BotAvatar id={bot.id} className="mx-auto mb-3 size-20 shadow-soft" />}
                  <p className="text-lg font-semibold tracking-tight text-foreground">{bot?.name ?? '新对话'}</p>
                  <p className="mt-1">{bot?.description || '发条消息开始。'}</p>
                </div>
              )}
              {items.map((it) => (
                <div key={it.key} className="msg-in">
                  <MessageItem item={it} />
                </div>
              ))}
              {s.streaming && items[items.length - 1]?.kind === 'user' && <p className="msg-in shimmer text-[13px]">思考中…</p>}
              {s.exit && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <p className="font-medium text-destructive">pi 进程退出（code {s.exit.code}）</p>
                  {s.exit.stderrTail && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{s.exit.stderrTail}</pre>}
                  {lastUser && (
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => void send(textOf(lastUser))}>
                      <RotateCcwIcon /> 重试
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            aria-hidden={atBottom}
            tabIndex={atBottom ? -1 : 0}
            className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-popover/90 shadow-soft backdrop-blur transition-[opacity,transform] duration-200 ${atBottom ? 'pointer-events-none translate-y-2 scale-95 opacity-0' : 'opacity-100'}`}
            onClick={() => setAtBottom(true)}
          >
            <ArrowDownIcon /> {s.streaming ? '回到最新' : '到底部'}
          </Button>
        </TabsContent>
        {bot && (
          <TabsContent value="goals" className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <BotGoals botId={id} />
          </TabsContent>
        )}
        {bot && (
          <TabsContent value="tasks" className="min-h-0 flex-1 overflow-y-auto">
            <BotTasks botId={id} />
          </TabsContent>
        )}
        <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
          <ActivityList items={activity} onJump={jump} />
        </TabsContent>
      </Tabs>
      <Composer sessionId={id} name={bot?.name} visionOk={visionOk} streaming={s.streaming} disabled={readOnly} queued={s.queue.steering.length + s.queue.followUp.length} onSend={send} onAbort={abort} />
      {s.uiRequests[0] && <ExtensionDialog key={s.uiRequests[0].id} req={s.uiRequests[0]} onReply={reply(s.uiRequests[0].id)} />}
      <BotDialog open={editBot} onOpenChange={setEditBot} bot={bot ?? undefined} adopt={bot ? undefined : { id, name: detail?.state?.sessionName || detail?.name }} onSaved={setBot} />
      <AlertDialog open={unset} onOpenChange={setUnset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>取消「{bot?.name}」的 Bot 身份？</AlertDialogTitle>
            <AlertDialogDescription>只去掉名字、人设和后台目标；会话、对话和文件都保留，之后随时可以再设为 Bot。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">算了</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={() => void unsetBot()}>
              取消 Bot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet open={info} onOpenChange={setInfo}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto pb-[max(env(safe-area-inset-bottom),16px)]">
          <SheetHeader>
            <SheetTitle>详情</SheetTitle>
            <SheetDescription>底层是一个 pi 会话；对话过长时 pi 会自动压缩上下文。</SheetDescription>
          </SheetHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 text-sm">
            {[
              ['模型', [model, detail?.state?.thinkingLevel].filter(Boolean).join(' · ')],
              ['工作目录', detail?.cwd],
              ['会话 ID', id],
              ['终端打开', `pi --session ${id}`],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-xs leading-5">{v || '—'}</dd>
              </div>
            ))}
          </dl>
          <div className="px-4">
            <Button variant="outline" className="min-h-11 w-full" disabled={readOnly} onClick={() => void release()}>
              交给终端（释放进程和锁）
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <ModelPicker open={settings} onOpenChange={setSettings} detail={detail} onSaved={refreshDetail} />
    </div>
  )
}
