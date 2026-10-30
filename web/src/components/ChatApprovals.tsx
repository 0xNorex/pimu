import { useCallback, useEffect, useState } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, errMsg } from '@/lib/api'
import type { InboxItem } from '@/lib/types'
import { useGlobalEvents } from '@/lib/useGlobalEvents'

// Approvals the guarded main session is waiting on, shown above the composer.
// The gate polls Pimu, so approving here lets the blocked call run (once).
export function ChatApprovals({ botId }: { botId: string }) {
  const [items, setItems] = useState<InboxItem[]>([])
  const load = useCallback(() => {
    api<{ items: InboxItem[] }>(`/api/inbox?bot=${botId}&open=1`)
      .then((r) => setItems(r.items.filter((it) => it.kind === 'approval' && !it.goalId && !it.jobId)))
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
        <div key={it.id} role="alert" className="attention-card rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm shadow-soft dark:border-amber-700 dark:bg-amber-950/40">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlertIcon className="size-4 shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1 truncate">
              审批 #{it.id} · {it.title}
            </span>
          </div>
          {it.body && <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-background/70 p-2 text-xs whitespace-pre-wrap">{it.body}</pre>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" className="min-h-9" onClick={() => void decide(it, 'deny')}>
              拒绝
            </Button>
            <Button size="sm" className="min-h-9" onClick={() => void decide(it, 'approve')}>
              批准一次
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
