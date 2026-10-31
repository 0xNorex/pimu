import { useCallback, useEffect, useState } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, errMsg } from '@/lib/api'
import type { InboxItem } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'

const VERB: [RegExp, string][] = [
  [/bash|shell|exec|command/i, '运行一条命令'],
  [/write|edit|patch|create/i, '修改文件'],
  [/browser|fetch|http|web/i, '访问网页'],
  [/send|mail|post|message/i, '发送消息'],
]
// "想调用 bash：清理缓存" → "它想运行一条命令：清理缓存"
export function approvalSentence(it: InboxItem): string {
  const m = /^想调用 ([^：]+)(?:：(.*))?$/.exec(it.title)
  if (!m) return it.title
  const verb = VERB.find(([re]) => re.test(m[1]))?.[1] ?? `用 ${m[1]}`
  return `它想${verb}${m[2]?.trim() ? `：${m[2].trim()}` : '。'}`
}

// What the bot (its chat or one of its background jobs) is waiting for you to
// allow. One sentence, Allow / Deny; the exact call is one tap away.
export function ChatApprovals({ botId }: { botId: string }) {
  const [items, setItems] = useState<InboxItem[]>([])
  const load = useCallback(() => {
    api<{ items: InboxItem[] }>(`/api/inbox?bot=${botId}&open=1`)
      .then((r) => setItems(r.items.filter((it) => it.kind === 'approval' && !it.goalId)))
      .catch(() => {})
  }, [botId])
  useEffect(load, [load])
  useGlobalEvents((e) => (e.type === 'inbox' || e.type === 'resync') && load())

  const decide = async (it: InboxItem, action: 'approve' | 'deny') => {
    try {
      await api(`/api/inbox/${it.id}`, { action })
      setItems((xs) => xs.filter((x) => x.id !== it.id))
    } catch (e) {
      toast.error(errMsg(e))
      load()
    }
  }
  if (!items.length) return null
  return (
    <div className="mx-auto w-full max-w-(--chat-w) space-y-2 px-4 pb-2">
      {items.map((it) => (
        <div key={it.id} role="alert" data-approval={it.id} className="attention-card rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm shadow-soft dark:border-amber-700 dark:bg-amber-950/40">
          <div className="flex items-start gap-2">
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{approvalSentence(it)}</p>
          </div>
          <div className="mt-2 flex items-center gap-2">
            {it.body ? (
              <details className="min-w-0 flex-1 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">详情</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-background/70 p-2 whitespace-pre-wrap">{it.body}</pre>
              </details>
            ) : (
              <span className="flex-1" />
            )}
            <Button variant="outline" size="sm" className="min-h-10 self-start" onClick={() => void decide(it, 'deny')}>
              拒绝
            </Button>
            <Button size="sm" className="min-h-10 self-start" onClick={() => void decide(it, 'approve')}>
              允许
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
