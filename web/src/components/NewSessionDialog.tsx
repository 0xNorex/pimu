import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, errMsg } from '@/lib/api'
import { go } from '@/lib/route'
import { modelKey, useModels } from './ModelPicker'

export function NewSessionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [workdirs, setWorkdirs] = useState<string[]>([])
  const [cwd, setCwd] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const models = useModels(open)

  useEffect(() => {
    if (!open) return
    api<{ workdirs: string[] }>('/api/workdirs')
      .then((r) => {
        setWorkdirs(r.workdirs)
        setCwd((c) => c || r.workdirs[0] || '')
      })
      .catch((e) => toast.error(errMsg(e)))
  }, [open])

  const create = async () => {
    setBusy(true)
    try {
      const m = models?.find((x) => modelKey(x) === model)
      const r = await api<{ id: string }>('/api/sessions', { cwd, provider: m?.provider, modelId: m?.id })
      onOpenChange(false)
      go(`#/s/${r.id}`)
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
          <DialogTitle>新会话</DialogTitle>
          <DialogDescription>在允许的目录（PIMU_WORKDIRS）里启动 pi。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cwd">目录</Label>
            <Input id="cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} className="min-h-11 font-mono text-base" list="workdirs" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <datalist id="workdirs">
              {workdirs.map((w) => (
                <option key={w} value={w} />
              ))}
            </datalist>
          </div>
          <div className="grid gap-2">
            <Label>model（可选）</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="min-h-11 w-full text-base">
                <SelectValue placeholder={models ? (models.length ? 'pi 默认' : '无可用模型：终端运行 pi 并 /login') : '加载中…'} />
              </SelectTrigger>
              <SelectContent>
                {models?.map((m) => (
                  <SelectItem key={modelKey(m)} value={modelKey(m)}>
                    {m.name} <span className="text-muted-foreground">· {m.provider}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={create} disabled={busy || !cwd}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
