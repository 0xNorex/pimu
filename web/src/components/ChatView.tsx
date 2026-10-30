import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDownIcon, ChevronLeftIcon, EllipsisVerticalIcon, RotateCcwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errMsg } from '@/lib/api'
import { textOf } from '@/lib/format'
import { go } from '@/lib/route'
import { initialStore, reducer } from '@/lib/store'
import { buildItems, toolActivity } from '@/lib/timeline'
import type { Model, SessionDetail } from '@/lib/types'
import { useSessionEvents } from '@/lib/useSessionEvents'
import { ActivityList } from './ActivityList'
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
  const send = async (message: string, behavior?: 'steer' | 'followUp') => {
    try {
      await api(`/api/sessions/${id}/prompt`, { message, behavior })
      dispatch({ type: 'clear_exit' })
      setAtBottom(true)
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
  const lastUser = [...s.messages].reverse().find((m) => m.role === 'user')

  const title = detail?.state?.sessionName || detail?.name || id
  const model = detail?.state?.model?.provider !== 'unknown' ? detail?.state?.model?.name || modelName || detail?.state?.model?.id : undefined

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-1 border-b px-2 pt-[env(safe-area-inset-top)]">
        <Button variant="ghost" size="icon" className="size-11 lg:hidden" aria-label="返回" onClick={() => go('#/')}>
          <ChevronLeftIcon />
        </Button>
        <div className="min-w-0 flex-1 py-2 pl-1">
          <h1 className="truncate text-[15px] font-medium">{title}</h1>
          <p className="truncate text-xs text-muted-foreground" aria-live="polite">
            {s.streaming ? `运行中 · ${model ?? 'pi'} · 已用 ${elapsed}s` : [model, detail?.state?.thinkingLevel, detail?.cwd].filter(Boolean).join(' · ')}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label="会话菜单">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setSettings(true)} disabled={readOnly}>
              模型 / thinking / 名称
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={release} disabled={readOnly}>
              交给终端（释放进程和锁）
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <ConnectionBanner connected={connected} lock={s.lock} />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-3 mt-2 self-start">
          <TabsTrigger value="chat">对话</TabsTrigger>
          <TabsTrigger value="activity">活动</TabsTrigger>
        </TabsList>
        <TabsContent value="chat" className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 text-[15px] leading-relaxed">
              {!s.loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
              {s.loaded && items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">新会话，发条消息开始。</p>}
              {items.map((it) => (
                <MessageItem key={it.key} item={it} />
              ))}
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
          {!atBottom && (
            <Button size="sm" variant="secondary" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow" onClick={() => setAtBottom(true)}>
              <ArrowDownIcon /> 新消息
            </Button>
          )}
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
          <ActivityList items={activity} onJump={jump} />
        </TabsContent>
      </Tabs>
      <Composer sessionId={id} streaming={s.streaming} disabled={readOnly} queued={s.queue.steering.length + s.queue.followUp.length} onSend={send} onAbort={abort} />
      {s.uiRequests[0] && <ExtensionDialog key={s.uiRequests[0].id} req={s.uiRequests[0]} onReply={reply(s.uiRequests[0].id)} />}
      <ModelPicker open={settings} onOpenChange={setSettings} detail={detail} onSaved={refreshDetail} />
    </div>
  )
}
