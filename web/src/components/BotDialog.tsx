import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { botsChanged } from '@/lib/bus'
import { api, errMsg } from '@/lib/api'
import { go } from '@/lib/route'
import { ASSISTANT, type Bot } from '@/lib/types'
import { DirPicker, lastDir, rememberDir } from './DirPicker'

// Anyone can open "new bot" ('+' in the sidebar, the empty screen); App mounts one NewBot.
export const openNewBot = () => dispatchEvent(new Event('pimu:new-bot'))
export function NewBot() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setOpen(true)
    addEventListener('pimu:new-bot', on)
    return () => removeEventListener('pimu:new-bot', on)
  }, [])
  return <BotDialog open={open} onOpenChange={setOpen} onSaved={(b) => (rememberDir(b.cwd), go(`#/s/${b.id}`))} />
}

type Props = {
  open: boolean
  onOpenChange: (o: boolean) => void
  bot?: Bot // edit; none = create
  onSaved?: (b: Bot) => void
}

export function BotDialog({ open, onOpenChange, bot, onSaved }: Props) {
  const [f, setF] = useState({ name: '', description: '', persona: '', cwd: '', mode: 'trusted' as Bot['mode'] })
  const [workdirs, setWorkdirs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  // Fixed while open, so the closing animation doesn't flip to "编辑 Bot" once the bot exists.
  const [edit, setEdit] = useState(!!bot)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    if (!open) return
    setEdit(!!bot)
    setF(bot ? { name: bot.name, description: bot.description, persona: bot.persona, cwd: bot.cwd, mode: bot.mode ?? 'trusted' } : { name: '', description: '', persona: '', cwd: lastDir(), mode: 'trusted' })
    api<{ workdirs: string[] }>('/api/workdirs').then((r) => setWorkdirs(r.workdirs)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot])

  const save = async (patch?: Partial<Bot>) => {
    setBusy(true)
    try {
      const r = bot
        ? await api<{ bot: Bot }>(`/api/bots/${bot.id}`, { ...f, ...patch }, 'PATCH')
        : await api<{ bot: Bot }>('/api/bots', f)
      onOpenChange(false)
      onSaved?.(r.bot)
      botsChanged()
      if (patch?.archived !== undefined) toast.success(patch.archived ? '已归档' : '已恢复')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const cwdField = (
    <div className="grid gap-2">
      <Label htmlFor="bot-cwd">工作目录</Label>
      <div className="flex gap-2">
        <Input id="bot-cwd" value={f.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder={workdirs[0] ?? '默认'} list="bot-workdirs" className="min-h-11 font-mono text-base" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => setPicking(true)}>
          选择…
        </Button>
      </div>
      <datalist id="bot-workdirs">
        {workdirs.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <p className="text-xs text-muted-foreground">它读写文件、存放上传附件的地方（.pimu/uploads/）。</p>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{edit ? '编辑 Bot' : '新建 Bot'}</DialogTitle>
          <DialogDescription>{edit ? '人设修改后从下一条消息起生效。' : '起个名字就能开聊；其余都可以以后再改。'}</DialogDescription>
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
            <Input id="bot-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={edit ? '' : '比如：写作助手'} className="min-h-11 text-base" maxLength={40} autoFocus={!edit} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bot-desc">一句话简介</Label>
            <Input id="bot-desc" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="列表里显示，可留空" className="min-h-11 text-base" maxLength={120} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bot-persona">人设 / 指令</Label>
            <Textarea id="bot-persona" value={f.persona} onChange={(e) => set('persona', e.target.value)} rows={edit ? 5 : 3} placeholder="它是谁、怎么说话、要遵守什么（可留空）" className="text-base" />
          </div>
          {!edit && cwdField}
          {edit && (
            <>
          <div className="grid gap-2">
            <Label>做事方式</Label>
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              {(
                [
                  ['trusted', '直接做', '默认：不打断你'],
                  ['guarded', '先问我', '改文件、跑命令前先在对话里问你'],
                ] as const
              ).map(([v, label, hint]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={f.mode === v}
                  onClick={() => setF((x) => ({ ...x, mode: v }))}
                  className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${f.mode === v ? 'border-primary bg-primary/5' : 'text-muted-foreground'}`}
                >
                  <div className="font-medium text-foreground">{label}</div>
                  <div className="text-xs">{hint}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">这不是系统沙箱，它仍有本机用户的权限。</p>
          </div>
          <Collapsible>
            <CollapsibleTrigger type="button" className="group flex min-h-11 items-center gap-1 text-sm text-muted-foreground">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
              高级
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-2 pt-1">{cwdField}</CollapsibleContent>
          </Collapsible>
            </>
          )}
          <DialogFooter className="gap-2">
            {edit && bot && bot.id !== ASSISTANT && (
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void save({ archived: !bot.archived })}>
                {bot.archived ? '恢复' : '归档'}
              </Button>
            )}
            <Button type="submit" className="min-h-11" disabled={busy || !f.name.trim()}>
              {edit ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <DirPicker open={picking} onOpenChange={setPicking} start={f.cwd || undefined} onPick={(p) => set('cwd', p)} />
    </Dialog>
  )
}
