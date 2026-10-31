import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, errMsg } from '@/lib/api'
import { botsChanged } from '@/lib/bus'
import { fmtDate } from '@/lib/format'
import { go } from '@/lib/route'
import type { Topic } from '@/lib/types'

// 继续这个话题: the topic becomes the bot's current conversation again.
export async function resumeTopic(botId: string, topic: string) {
  try {
    await api(`/api/bots/${botId}/topics/${topic}/resume`, {})
    botsChanged()
    go(`#/s/${botId}`)
    return true
  } catch (e) {
    toast.error(errMsg(e))
    return false
  }
}

// 详情 → 历史: the bot's earlier conversations, newest first. Tap to read; 继续 to pick it up again.
export function BotHistory({ botId, onOpen }: { botId: string; onOpen?: () => void }) {
  const [topics, setTopics] = useState<Topic[] | null>(null)
  useEffect(() => {
    api<{ topics: Topic[] }>(`/api/bots/${botId}/topics`)
      .then((r) => setTopics(r.topics))
      .catch(() => setTopics([]))
  }, [botId])
  if (!topics) return null
  if (topics.length === 0) return <p className="text-sm text-muted-foreground">还没有以前的话题。用「新话题」开始一段新的对话，之前的会收在这里。</p>
  return (
    <ul className="-mx-2 space-y-0.5" aria-label="以前的话题">
      {topics.map((t) => (
        <li key={t.id} className="flex items-center gap-1 rounded-lg hover:bg-foreground/[0.04]" data-topic={t.id}>
          <a href={`#/s/${t.id}`} onClick={onOpen} className="min-w-0 flex-1 rounded-lg px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="block truncate text-sm">{t.title}</span>
            <span className="block text-xs text-muted-foreground tabular-nums">{fmtDate(t.updatedAt)}</span>
          </a>
          <Button variant="ghost" size="sm" className="min-h-9 shrink-0 text-primary" onClick={() => void resumeTopic(botId, t.id).then((ok) => ok && onOpen?.())}>
            继续
          </Button>
        </li>
      ))}
    </ul>
  )
}
