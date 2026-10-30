import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { PlayIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, errMsg } from '@/lib/api'
import { cronLabel, CRON_PRESETS, fmtDate, fmtDuration } from '@/lib/format'
import { go } from '@/lib/route'
import type { Model, Task, TaskRun } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { PageHeader } from './PageHeader'
import { RunBadge, TRIGGER } from './RunBadge'

type Form = Pick<Task, 'name' | 'prompt' | 'cwd' | 'sessionMode' | 'notify' | 'enabled'> & {
  schedule: string
  model: string
  sessionId: string
  maxRetries: string
  timeoutSec: string
}

const DEFAULT_MODEL = '__default__'
const blank: Form = { name: '', prompt: '', cwd: '', schedule: '', model: DEFAULT_MODEL, sessionMode: 'new', sessionId: '', notify: 'failure', maxRetries: '1', timeoutSec: '1800', enabled: true }
const toForm = (t: Task): Form => ({
  ...t,
  schedule: t.schedule ?? '',
  model: t.model ?? DEFAULT_MODEL,
  sessionId: t.sessionId ?? '',
  maxRetries: String(t.maxRetries),
  timeoutSec: String(t.timeoutSec),
})

function Field({ label, id, hint, children }: { label: string; id: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TaskDetail({ id }: { id: number | 'new' }) {
  const isNew = id === 'new'
  const [task, setTask] = useState<Task | null>(null)
  const [form, setForm] = useState<Form | null>(isNew ? blank : null)
  const [runs, setRuns] = useState<TaskRun[] | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [workdirs, setWorkdirs] = useState<string[]>([])
  const [tab, setTab] = useState(isNew ? 'settings' : 'runs')
  const [saving, setSaving] = useState(false)

  const loadRuns = useCallback(() => {
    if (!isNew) api<{ runs: TaskRun[] }>(`/api/runs?task_id=${id}&limit=50`).then((r) => setRuns(r.runs)).catch(() => {})
  }, [id, isNew])

  useEffect(() => {
    api<{ models: Model[] }>('/api/models').then((r) => setModels(r.models)).catch(() => {})
    api<{ workdirs: string[] }>('/api/workdirs')
      .then((r) => {
        setWorkdirs(r.workdirs)
        if (isNew) setForm((f) => (f && !f.cwd ? { ...f, cwd: r.workdirs[0] ?? '' } : f))
      })
      .catch(() => {})
    if (!isNew)
      api<{ task: Task }>(`/api/tasks/${id}`)
        .then((r) => {
          setTask(r.task)
          setForm(toForm(r.task))
        })
        .catch((e) => toast.error(errMsg(e)))
    loadRuns()
  }, [id, isNew, loadRuns])

  useGlobalEvents((e) => {
    if ((e.type === 'run_update' && e.run.taskId === id) || e.type === 'resync') loadRuns()
  })

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  const save = async () => {
    if (!form) return
    setSaving(true)
    const body = {
      ...form,
      schedule: form.schedule.trim() || null,
      model: form.model === DEFAULT_MODEL ? null : form.model,
      sessionId: form.sessionId.trim() || null,
      maxRetries: Number(form.maxRetries),
      timeoutSec: Number(form.timeoutSec),
    }
    try {
      const r = isNew ? await api<{ task: Task }>('/api/tasks', body) : await api<{ task: Task }>(`/api/tasks/${id}`, body, 'PATCH')
      toast.success('已保存')
      if (isNew) go(`#/tasks/${r.task.id}`)
      else {
        setTask(r.task)
        setForm(toForm(r.task))
      }
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    try {
      await api(`/api/tasks/${id}`, undefined, 'DELETE')
      toast.success('已删除')
      go('#/tasks')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const runNow = async () => {
    try {
      await api(`/api/tasks/${id}/run`, {})
      setTab('runs')
      loadRuns()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <PageHeader title={isNew ? '新建任务' : (task?.name ?? '任务')} back="#/tasks" backAlways>
        {!isNew && (
          <Button variant="outline" className="min-h-11" onClick={() => void runNow()}>
            <PlayIcon />
            立即运行
          </Button>
        )}
      </PageHeader>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        {!isNew && (
          <TabsList className="mx-3 mt-2 self-start">
            <TabsTrigger value="runs">运行记录</TabsTrigger>
            <TabsTrigger value="settings">设置</TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto">
          {task && (
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              {cronLabel(task.schedule)}
              {task.enabled && task.nextRun ? ` · 下次 ${fmtDate(task.nextRun)}` : task.enabled ? '' : ' · 已停用'} · 失败重试 {task.maxRetries} 次
            </p>
          )}
          {!runs && <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
          {runs?.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">还没有运行记录。</p>}
          <ul className="divide-y pb-[env(safe-area-inset-bottom)]">
            {runs?.map((r) => (
              <li key={r.id}>
                <a href={r.sessionId ? `#/s/${r.sessionId}` : undefined} className="block min-h-11 px-4 py-3 hover:bg-muted/60">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <RunBadge status={r.status} />
                    <span>
                      #{r.id} · {TRIGGER[r.trigger]}
                      {r.attempt > 1 ? ` · 第 ${r.attempt} 次` : ''}
                    </span>
                    <span className="ml-auto tabular-nums">
                      {fmtDate(r.createdAt)}
                      {r.finishedAt ? ` · ${fmtDuration(r.startedAt, r.finishedAt)}` : ''}
                    </span>
                  </div>
                  {r.summary && <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm">{r.summary.replace(/\n{2,}/g, '\n')}</p>}
                  {r.error && r.status !== 'succeeded' && <p className="mt-1 font-mono text-xs text-destructive">{r.error}</p>}
                </a>
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
          {!form ? (
            <div className="space-y-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11" />)}</div>
          ) : (
            <form
              className="mx-auto max-w-2xl space-y-4 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <Field label="名称" id="name">
                <Input id="name" value={form.name} onChange={(e) => set('name', e.target.value)} className="min-h-11 text-base" required />
              </Field>
              <Field label="提示词" id="prompt">
                <Textarea id="prompt" value={form.prompt} onChange={(e) => set('prompt', e.target.value)} className="min-h-28 text-base" required />
              </Field>
              <Field label="工作目录" id="cwd">
                <Input id="cwd" value={form.cwd} onChange={(e) => set('cwd', e.target.value)} className="min-h-11 font-mono text-base" list="task-workdirs" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <datalist id="task-workdirs">
                  {workdirs.map((w) => (
                    <option key={w} value={w} />
                  ))}
                </datalist>
              </Field>
              <Field label="计划（cron，服务器本地时间）" id="schedule" hint={form.schedule.trim() ? `分 时 日 月 周 · ${cronLabel(form.schedule.trim())}` : '留空表示只在点“立即运行”时执行一次'}>
                <Input id="schedule" value={form.schedule} onChange={(e) => set('schedule', e.target.value)} placeholder="例如 0 9 * * 1-5" className="min-h-11 font-mono text-base" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[['', '仅手动'] as const, ...CRON_PRESETS].map(([spec, label]) => (
                    <Button key={label} type="button" size="sm" variant={form.schedule.trim() === spec ? 'secondary' : 'outline'} onClick={() => set('schedule', spec)}>
                      {label}
                    </Button>
                  ))}
                </div>
              </Field>
              <Field label="模型" id="model">
                <Select value={form.model} onValueChange={(v) => set('model', v)}>
                  <SelectTrigger id="model" className="min-h-11 w-full text-base">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL}>默认（pi 设置）</SelectItem>
                    {models.map((m) => (
                      <SelectItem key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                        {m.name} · {m.provider}
                      </SelectItem>
                    ))}
                    {form.model !== DEFAULT_MODEL && !models.some((m) => `${m.provider}/${m.id}` === form.model) && <SelectItem value={form.model}>{form.model}</SelectItem>}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="会话" id="mode">
                  <Select value={form.sessionMode} onValueChange={(v) => set('sessionMode', v as Form['sessionMode'])}>
                    <SelectTrigger id="mode" className="min-h-11 w-full text-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">每次新建会话</SelectItem>
                      <SelectItem value="reuse">复用指定会话</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Telegram 通知" id="notify">
                  <Select value={form.notify} onValueChange={(v) => set('notify', v as Form['notify'])}>
                    <SelectTrigger id="notify" className="min-h-11 w-full text-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="failure">仅失败时</SelectItem>
                      <SelectItem value="always">每次</SelectItem>
                      <SelectItem value="never">从不</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {form.sessionMode === 'reuse' && (
                <Field label="会话 ID" id="sid" hint="被占用（Pimu 或终端正在使用）时本次运行记为失败">
                  <Input id="sid" value={form.sessionId} onChange={(e) => set('sessionId', e.target.value)} className="min-h-11 font-mono text-base" autoCapitalize="off" spellCheck={false} />
                </Field>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Field label="失败重试次数" id="retries" hint="间隔 1 分钟">
                  <Input id="retries" type="number" min={0} max={5} value={form.maxRetries} onChange={(e) => set('maxRetries', e.target.value)} className="min-h-11 text-base" />
                </Field>
                <Field label="超时（秒）" id="timeout">
                  <Input id="timeout" type="number" min={30} max={86400} value={form.timeoutSec} onChange={(e) => set('timeoutSec', e.target.value)} className="min-h-11 text-base" />
                </Field>
              </div>
              <div className="flex min-h-11 items-center justify-between">
                <Label htmlFor="enabled">启用</Label>
                <Switch id="enabled" checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
              </div>
              <div className="flex gap-2 pt-2">
                <Button type="submit" className="min-h-11 flex-1" disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </Button>
                {!isNew && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="outline" className="min-h-11 text-destructive" aria-label="删除任务">
                        <Trash2Icon />
                        删除
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>删除任务「{form.name}」？</AlertDialogTitle>
                        <AlertDialogDescription>运行记录会一并删除；已产生的 pi 会话文件保留。</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void remove()}>删除</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </form>
          )}
        </TabsContent>
      </Tabs>
    </main>
  )
}
