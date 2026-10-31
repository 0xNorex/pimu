import { useCallback, useEffect, useState } from 'react'
import { ChevronDownIcon, CopyIcon, HeartPulseIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, errMsg } from '@/lib/api'
import { every, fmtDate } from '@/lib/format'
import type { Beat, Goal, GoalDetail } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'

const BEAT: Record<Beat['status'], string> = { running: '运行中', ok: '完成', budget: '超预算', error: '出错' }

// Goals make a bot proactive: each heartbeat runs a fresh pi session that reads GOAL.md and decides.
export function BotGoals({ botId }: { botId: string }) {
  const [goals, setGoals] = useState<Goal[] | null>(null)
  const [edit, setEdit] = useState<Goal | 'new' | null>(null)
  const load = useCallback(() => {
    api<{ goals: Goal[] }>(`/api/bots/${botId}/goals`).then((r) => setGoals(r.goals)).catch(() => {})
  }, [botId])
  useEffect(load, [load])
  useGlobalEvents((e) => (e.type === 'goal_update' || e.type === 'resync') && load())

  return (
    <div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">给它目标，它会按心跳自己检查，只在重要时通知你。</p>
          <Button size="sm" className="min-h-9 shrink-0" onClick={() => setEdit('new')}>
            <PlusIcon /> 新目标
          </Button>
        </div>
        {goals?.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">还没有目标</p>}
        {goals?.map((g) => <GoalCard key={g.id} g={g} onEdit={() => setEdit(g)} reload={load} />)}
      </div>
      {edit && <GoalForm botId={botId} goal={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  )
}

function GoalCard({ g, onEdit, reload }: { g: Goal; onEdit: () => void; reload: () => void }) {
  const [d, setD] = useState<GoalDetail | null>(null)
  const [open, setOpen] = useState(false)
  const loadD = useCallback(() => void api<GoalDetail>(`/api/goals/${g.id}`).then(setD).catch(() => {}), [g.id])
  useEffect(() => {
    if (open) loadD()
  }, [open, loadD, g.lastBeat?.id, g.lastBeat?.status])

  const toggle = async (enabled: boolean) => {
    try {
      await api(`/api/goals/${g.id}`, { enabled }, 'PATCH')
    } catch (e) {
      toast.error(errMsg(e))
    }
    reload()
  }
  const beat = async () => {
    try {
      await api(`/api/goals/${g.id}/beat`, {})
      toast.success('心跳已开始', { description: '结果会出现在下方和收件箱' })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const lb = g.lastBeat
  return (
    <Card className={`gap-2 py-3 ${g.enabled ? '' : 'opacity-70'}`}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          {g.title}
          <Badge variant="outline">L{g.level}</Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          {every(g.everySec)}
          {g.activeHours && ` · ${g.activeHours} 点`} · 今日 {Math.round(g.todayTokens / 1000)}k / {Math.round(g.dayTokens / 1000)}k tok
        </CardDescription>
        <CardAction>
          <Switch checked={g.enabled} onCheckedChange={(v) => void toggle(v)} aria-label={g.enabled ? '停用目标' : '启用目标'} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-sm">
        {lb ? (
          <p className="line-clamp-2 text-muted-foreground">
            <span className="text-foreground">{BEAT[lb.status]}</span> · {fmtDate(lb.startedAt)} · {lb.outcome || '—'}
            {lb.summary && ` — ${lb.summary}`}
          </p>
        ) : (
          <p className="text-muted-foreground">尚未心跳</p>
        )}
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{g.precheck ? `下次：${g.precheck}` : '下一分钟内会心跳'}</span>
          <Button variant="ghost" size="icon" className="size-9" aria-label="编辑目标" onClick={onEdit}>
            <PencilIcon />
          </Button>
          <Button variant="outline" size="sm" className="min-h-9" onClick={() => void beat()}>
            <HeartPulseIcon /> 立即心跳
          </Button>
        </div>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`} /> 心跳记录与状态
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            {d && <Detail d={d} />}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

function Detail({ d }: { d: GoalDetail }) {
  const copy = () => void navigator.clipboard.writeText(d.hookUrl).then(() => toast.success('已复制 webhook 地址'))
  return (
    <>
      <ul className="divide-y rounded-md border text-xs">
        {d.beats.length === 0 && <li className="p-2 text-muted-foreground">没有心跳记录</li>}
        {d.beats.map((b) => (
          <li key={b.id} className="flex gap-2 p-2">
            <span className="w-14 shrink-0 text-muted-foreground">{fmtDate(b.startedAt)}</span>
            <span className={`w-12 shrink-0 ${b.status === 'ok' ? '' : 'text-destructive'}`}>{BEAT[b.status]}</span>
            <span className="min-w-0 flex-1 truncate" title={b.summary}>
              <span className="font-mono">{b.outcome || '—'}</span> {b.summary}
            </span>
            <span className="shrink-0 text-muted-foreground">{Math.round(b.tokens / 1000)}k</span>
          </li>
        ))}
      </ul>
      {d.stateMd && <Block label="STATE.md（它的笔记）" text={d.stateMd} />}
      {d.findings && <Block label="发现" text={d.findings} />}
      <div className="space-y-1">
        <p className="text-xs font-medium">Webhook</p>
        <div className="flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{d.hookUrl.replace(/k=[^&]+/, 'k=••••')}</code>
          <Button variant="ghost" size="icon" className="size-8" aria-label="复制 webhook 地址" onClick={copy}>
            <CopyIcon />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">POST 到这里会唤醒一次心跳；GitHub 按 X-GitHub-Delivery 去重。</p>
      </div>
    </>
  )
}

const Block = ({ label, text }: { label: string; text: string }) => (
  <div className="space-y-1">
    <p className="text-xs font-medium">{label}</p>
    <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{text}</pre>
  </div>
)

function GoalForm({ botId, goal, onClose, onSaved }: { botId: string; goal?: Goal; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    title: goal?.title ?? '',
    goal: '',
    level: String(goal?.level ?? 1),
    everyMin: String((goal?.everySec ?? 3600) / 60),
    activeHours: goal?.activeHours ?? '',
    runMin: String((goal?.runSec ?? 600) / 60),
    runK: String((goal?.runTokens ?? 200000) / 1000),
    dayK: String((goal?.dayTokens ?? 1000000) / 1000),
  })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (goal) void api<GoalDetail>(`/api/goals/${goal.id}`).then((d) => setF((x) => ({ ...x, goal: d.goalMd })))
  }, [goal])
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }))

  const save = async () => {
    setBusy(true)
    const body = {
      title: f.title,
      goal: f.goal,
      level: Number(f.level),
      everyMin: Number(f.everyMin),
      activeHours: f.activeHours.trim(),
      runSec: Math.round(Number(f.runMin) * 60),
      runTokens: Math.round(Number(f.runK) * 1000),
      dayTokens: Math.round(Number(f.dayK) * 1000),
    }
    try {
      if (goal) await api(`/api/goals/${goal.id}`, body, 'PATCH')
      else await api(`/api/bots/${botId}/goals`, body)
      toast.success(goal ? '已保存' : '目标已创建，下一分钟内开始心跳')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const del = async () => {
    if (!goal || !confirm(`删除目标「${goal.title}」？心跳记录和收件箱条目会一起删除。`)) return
    try {
      await api(`/api/goals/${goal.id}`, {}, 'DELETE')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{goal ? '编辑目标' : '新目标'}</DialogTitle>
          <DialogDescription>写清楚要盯什么、什么情况才值得打扰你。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="标题">
            <Input value={f.title} onChange={(e) => set('title')(e.target.value)} placeholder="盯 CI / 每日简报…" />
          </Field>
          <Field label="目标（GOAL.md）">
            <Textarea value={f.goal} onChange={(e) => set('goal')(e.target.value)} rows={6} placeholder={'每次心跳检查 …\n- 正常：什么都不做\n- 出现 … 时：通知我'} />
          </Field>
          <Field label="权限">
            <Select value={f.level} onValueChange={set('level')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">L1 · 只读，只能通知/提问</SelectItem>
                <SelectItem value="2">L2 · 可写工作目录，其余操作要你批准</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="间隔（分钟，≥10）">
              <Input inputMode="numeric" value={f.everyMin} onChange={(e) => set('everyMin')(e.target.value)} />
            </Field>
            <Field label="活跃时段（如 8-23）">
              <Input value={f.activeHours} onChange={(e) => set('activeHours')(e.target.value)} placeholder="全天" />
            </Field>
            <Field label="单次时限（分钟）">
              <Input inputMode="decimal" value={f.runMin} onChange={(e) => set('runMin')(e.target.value)} />
            </Field>
            <Field label="单次 token 上限（k）">
              <Input inputMode="numeric" value={f.runK} onChange={(e) => set('runK')(e.target.value)} />
            </Field>
            <Field label="每日 token 上限（k）">
              <Input inputMode="numeric" value={f.dayK} onChange={(e) => set('dayK')(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {goal && (
            <Button variant="ghost" className="text-destructive sm:mr-auto" onClick={() => void del()}>
              删除
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !f.title.trim()} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid gap-1.5">
    <Label className="text-xs">{label}</Label>
    {children}
  </div>
)
