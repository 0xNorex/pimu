import { useCallback, useEffect, useState } from 'react'
import { PlayIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, errMsg } from '@/lib/api'
import { cronLabel, fmtDate } from '@/lib/format'
import { go } from '@/lib/route'
import type { Task } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'
import { PageHeader } from './PageHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RunBadge, TRIGGER } from './RunBadge'

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const load = useCallback(() => api<{ tasks: Task[] }>('/api/tasks').then((r) => setTasks(r.tasks)).catch((e) => toast.error(errMsg(e))), [])
  useEffect(() => void load(), [load])
  useGlobalEvents((e) => (e.type === 'run_update' || e.type === 'resync') && void load())

  const toggle = async (t: Task, enabled: boolean) => {
    setTasks((ts) => ts?.map((x) => (x.id === t.id ? { ...x, enabled } : x)) ?? null)
    try {
      await api(`/api/tasks/${t.id}`, { enabled }, 'PATCH')
      void load()
    } catch (e) {
      toast.error(errMsg(e))
      void load()
    }
  }
  const runNow = async (t: Task) => {
    try {
      await api(`/api/tasks/${t.id}/run`, {})
      toast.success(`已开始运行「${t.name}」`)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <main className="page-in flex min-w-0 flex-1 flex-col">
      <PageHeader title="任务" back="#/">
        <Button size="sm" className="h-9" onClick={() => go('#/tasks/new')}>
          <PlusIcon /> 新建
        </Button>
      </PageHeader>
      <ScrollArea className="flex-1">
      <div className="p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] lg:p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {!tasks && [0, 1].map((i) => <Skeleton key={i} className="h-32" />)}
          {tasks?.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">还没有任务</p>
              <p className="mt-1">任务会按计划在后台启动 pi 执行提示词。点右上角“新建”。</p>
            </div>
          )}
          {tasks?.map((t) => (
            <Card key={t.id} className={`gap-3 py-4 ${t.enabled ? '' : 'opacity-70'}`}>
              <CardHeader className="px-4">
                <CardTitle>
                  <a href={`#/tasks/${t.id}`} className="hover:underline">
                    {t.name}
                  </a>
                </CardTitle>
                <CardDescription className="font-mono text-xs">{t.cwd}</CardDescription>
                <CardAction>
                  <Switch checked={t.enabled} onCheckedChange={(v) => void toggle(t, v)} aria-label={t.enabled ? '停用任务' : '启用任务'} />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-2 px-4 text-sm">
                <p className="line-clamp-2 text-muted-foreground">{t.prompt}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    计划：<span className="text-foreground">{cronLabel(t.schedule)}</span>
                  </span>
                  {t.enabled && t.nextRun && <span>下次 {fmtDate(t.nextRun)}</span>}
                  {!t.enabled && <span>已停用</span>}
                </div>
                <div className="flex items-center gap-2">
                  {t.lastRun ? (
                    <a href={`#/tasks/${t.id}`} className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
                      <RunBadge status={t.lastRun.status} />
                      <span className="truncate">
                        {TRIGGER[t.lastRun.trigger]} · {fmtDate(t.lastRun.createdAt)}
                      </span>
                    </a>
                  ) : (
                    <span className="flex-1 text-xs text-muted-foreground">尚未运行</span>
                  )}
                  <Button variant="outline" className="min-h-11" onClick={() => void runNow(t)}>
                    <PlayIcon />
                    立即运行
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      </ScrollArea>
    </main>
  )
}
