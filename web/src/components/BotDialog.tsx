import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, errMsg } from '@/lib/api'
import { go } from '@/lib/route'
import type { Bot } from '@/lib/types'

type Props = {
  open: boolean
  onOpenChange: (o: boolean) => void
  bot?: Bot // edit
  adopt?: { id: string; name?: string } // turn an existing session into a bot
  onSaved?: (b: Bot) => void
}

export function BotDialog({ open, onOpenChange, bot, adopt, onSaved }: Props) {
  const [f, setF] = useState({ name: '', description: '', persona: '', cwd: '' })
  const [workdirs, setWorkdirs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    if (!open) return
    setF(bot ? { name: bot.name, description: bot.description, persona: bot.persona, cwd: bot.cwd } : { name: adopt?.name ?? '', description: '', persona: '', cwd: '' })
    api<{ workdirs: string[] }>('/api/workdirs').then((r) => setWorkdirs(r.workdirs)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot, adopt?.id, adopt?.name])

  const save = async (patch?: Partial<Bot>) => {
    setBusy(true)
    try {
      const r = bot
        ? await api<{ bot: Bot }>(`/api/bots/${bot.id}`, { ...f, ...patch }, 'PATCH')
        : await api<{ bot: Bot }>('/api/bots', { ...f, sessionId: adopt?.id })
      onOpenChange(false)
      onSaved?.(r.bot)
      if (!bot && !adopt) go(`#/s/${r.bot.id}`)
      if (patch?.archived !== undefined) toast.success(patch.archived ? '已归档' : '已恢复')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{bot ? '编辑 Bot' : adopt ? '设为 Bot' : '新建 Bot'}</DialogTitle>
          <DialogDescription>{bot ? '人设修改后从下一条消息起生效。' : '起个名字就行，留空自动命名。人设等以后点头像再改。'}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="bot-name">名字</Label>
            <Input id="bot-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={bot ? '' : '留空自动命名，例如：翻译官'} className="min-h-11 text-base" maxLength={40} autoFocus={!bot} />
          </div>
          {bot && (
            <>
          <div className="grid gap-2">
            <Label htmlFor="bot-desc">一句话简介</Label>
            <Input id="bot-desc" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="列表里显示，可留空" className="min-h-11 text-base" maxLength={120} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bot-persona">人设 / 指令</Label>
            <Textarea id="bot-persona" value={f.persona} onChange={(e) => set('persona', e.target.value)} rows={5} placeholder="它是谁、怎么说话、要遵守什么" className="text-base" />
          </div>
          <Collapsible>
            <CollapsibleTrigger type="button" className="group flex min-h-11 items-center gap-1 text-sm text-muted-foreground">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
              高级
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-2 pt-1">
              <Label htmlFor="bot-cwd">工作目录</Label>
              <Input id="bot-cwd" value={f.cwd} onChange={(e) => set('cwd', e.target.value)} disabled={!!adopt} placeholder={workdirs[0] ?? '默认'} list="bot-workdirs" className="min-h-11 font-mono text-base" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <datalist id="bot-workdirs">
                {workdirs.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">它读写文件、存放上传附件的地方（.pimu/uploads/）。</p>
            </CollapsibleContent>
          </Collapsible>
            </>
          )}
          <DialogFooter className="gap-2">
            {bot && (
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void save({ archived: !bot.archived })}>
                {bot.archived ? '恢复' : '归档'}
              </Button>
            )}
            <Button type="submit" className="min-h-11" disabled={busy || (!!bot && !f.name.trim())}>
              {bot ? '保存' : '开始聊天'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
