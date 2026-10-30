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

const EMOJIS = ['🤖', '🧠', '📎', '🌐', '✍️', '📈', '🧑‍🍳', '🏴‍☠️', '🩺', '🎧']

type Props = {
  open: boolean
  onOpenChange: (o: boolean) => void
  bot?: Bot // edit
  adopt?: { id: string; name?: string } // turn an existing session into a bot
  onSaved?: (b: Bot) => void
}

export function BotDialog({ open, onOpenChange, bot, adopt, onSaved }: Props) {
  const [f, setF] = useState({ name: '', emoji: '🤖', description: '', persona: '', cwd: '' })
  const [workdirs, setWorkdirs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    if (!open) return
    setF(bot ? { name: bot.name, emoji: bot.emoji, description: bot.description, persona: bot.persona, cwd: bot.cwd } : { name: adopt?.name ?? '', emoji: '🤖', description: '', persona: '', cwd: '' })
    api<{ workdirs: string[] }>('/api/workdirs').then((r) => setWorkdirs(r.workdirs)).catch(() => {})
  }, [open, bot, adopt])

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
          <DialogDescription>每个 Bot 是一个独立的长期对话，带自己的名字和人设。</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="grid gap-2">
            <Label>头像</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {EMOJIS.map((em) => (
                <button key={em} type="button" onClick={() => set('emoji', em)} aria-label={`头像 ${em}`} aria-pressed={f.emoji === em} className={`flex size-10 items-center justify-center rounded-full text-xl ${f.emoji === em ? 'bg-primary/15 ring-2 ring-primary' : 'bg-muted hover:bg-muted/70'}`}>
                  {em}
                </button>
              ))}
              <Input value={f.emoji} onChange={(e) => set('emoji', e.target.value)} className="h-10 w-16 text-center text-xl" aria-label="自定义头像 emoji" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bot-name">名字</Label>
            <Input id="bot-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：翻译官" className="min-h-11 text-base" maxLength={40} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bot-desc">一句话简介</Label>
            <Input id="bot-desc" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="列表里显示，可留空" className="min-h-11 text-base" maxLength={120} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bot-persona">人设 / 指令</Label>
            <Textarea id="bot-persona" value={f.persona} onChange={(e) => set('persona', e.target.value)} rows={5} placeholder="它是谁、怎么说话、要遵守什么。修改后从下一条消息起生效。" className="text-base" />
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
          <DialogFooter className="gap-2">
            {bot && (
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void save({ archived: !bot.archived })}>
                {bot.archived ? '恢复' : '归档'}
              </Button>
            )}
            <Button type="submit" className="min-h-11" disabled={busy || !f.name.trim()}>
              {bot ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
