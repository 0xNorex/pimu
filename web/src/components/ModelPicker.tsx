import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, errMsg } from '@/lib/api'
import type { Model, SessionDetail } from '@/lib/types'

export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const modelKey = (m?: Pick<Model, 'provider' | 'id'>) => (m ? `${m.provider}/${m.id}` : '')

export function useModels(open: boolean) {
  const [models, setModels] = useState<Model[] | null>(null)
  useEffect(() => {
    if (!open || models) return
    api<{ models: Model[] }>('/api/models')
      .then((r) => setModels(r.models))
      .catch((e) => {
        setModels([])
        toast.error(errMsg(e))
      })
  }, [open, models])
  return models
}

type Props = { open: boolean; onOpenChange: (o: boolean) => void; detail: SessionDetail | null; onSaved: () => void }

export function ModelPicker({ open, onOpenChange, detail, onSaved }: Props) {
  const models = useModels(open)
  const [model, setModel] = useState('')
  const [thinking, setThinking] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const cur = detail?.state?.model
    setModel(cur && cur.provider !== 'unknown' ? modelKey(cur) : '')
    setThinking(detail?.state?.thinkingLevel ?? '')
    setName(detail?.state?.sessionName ?? detail?.name ?? '')
  }, [open, detail])

  const save = async () => {
    if (!detail) return
    setBusy(true)
    const base = `/api/sessions/${detail.id}`
    try {
      const m = models?.find((x) => modelKey(x) === model)
      if (m && model !== modelKey(detail.state?.model)) await api(`${base}/model`, { provider: m.provider, modelId: m.id })
      if (thinking && thinking !== detail.state?.thinkingLevel) await api(`${base}/thinking`, { level: thinking })
      if (name.trim() && name.trim() !== (detail.state?.sessionName ?? detail.name ?? '')) await api(`${base}/name`, { name: name.trim() })
      onSaved()
      onOpenChange(false)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>会话设置</DialogTitle>
          <DialogDescription>修改会通过 pi 写入会话。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>model</Label>
            {models && models.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有可用模型：在终端运行 `pi` 并 `/login`。</p>
            ) : (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="min-h-11 w-full text-base">
                  <SelectValue placeholder={models ? '选择模型' : '加载中…'} />
                </SelectTrigger>
                <SelectContent>
                  {models?.map((m) => (
                    <SelectItem key={modelKey(m)} value={modelKey(m)}>
                      {m.name} <span className="text-muted-foreground">· {m.provider}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid gap-2">
            <Label>thinking</Label>
            <Select value={thinking} onValueChange={setThinking}>
              <SelectTrigger className="min-h-11 w-full text-base">
                <SelectValue placeholder="默认" />
              </SelectTrigger>
              <SelectContent>
                {THINKING.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sname">名称</Label>
            <Input id="sname" value={name} onChange={(e) => setName(e.target.value)} className="min-h-11 text-base" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
