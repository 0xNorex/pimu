import { useCallback, useEffect, useState } from 'react'
import { RotateCcwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError, errMsg } from '@/lib/api'
import { PageHeader } from './PageHeader'

type Mem = { path: string; content: string; mtime: number }

// Edits pi's global AGENTS.md; mtime guards against overwriting edits made elsewhere.
export function MemoryPage() {
  const [mem, setMem] = useState<Mem | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)

  const load = useCallback(() => {
    api<Mem>('/api/memory')
      .then((m) => {
        setMem(m)
        setText(m.content)
        setConflict(false)
      })
      .catch((e) => toast.error(errMsg(e)))
  }, [])
  useEffect(load, [load])

  const dirty = mem !== null && text !== mem.content
  const save = async () => {
    if (!mem) return
    setSaving(true)
    try {
      const r = await api<{ mtime: number }>('/api/memory', { content: text, mtime: mem.mtime }, 'PUT')
      setMem({ ...mem, content: text, mtime: r.mtime })
      toast.success('已保存，新会话生效')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true)
      else toast.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <PageHeader title="记忆" back="#/">
        <Button className="min-h-11" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <p className="text-xs text-muted-foreground">
          pi 的全局指令文件 <span className="font-mono">{mem?.path ?? 'AGENTS.md'}</span>，每个新会话启动时读取。{dirty && <span className="text-foreground"> · 未保存</span>}
        </p>
        {conflict && (
          <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">
            <span className="flex-1">文件已在别处被修改。重新加载会丢弃这里的改动。</span>
            <Button size="sm" variant="outline" onClick={load}>
              <RotateCcwIcon />
              重新加载
            </Button>
          </div>
        )}
        {!mem ? (
          <Skeleton className="flex-1" />
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                if (dirty) void save()
              }
            }}
            placeholder={'# 全局记忆\n- 例如：回答使用简体中文'}
            className="min-h-0 flex-1 resize-none font-mono text-[14px] leading-relaxed"
            aria-label="AGENTS.md 内容"
            spellCheck={false}
          />
        )}
      </div>
    </main>
  )
}
