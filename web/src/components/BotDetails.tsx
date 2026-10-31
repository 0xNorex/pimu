import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, errMsg } from '@/lib/api'
import { botsChanged } from '@/lib/bus'
import { archiveBot } from '@/lib/newBot'
import { go } from '@/lib/route'
import { ASSISTANT, type Bot } from '@/lib/types'
import { BotAvatar } from './BotAvatar'
import { BotGoals } from './BotGoals'
import { BotHistory } from './BotHistory'
import { BotJobs } from './BotJobs'
import { BotTasks } from './BotTasks'

// Collapsed by default: the drawer opens on what matters (pause + background work).
export function Fold({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group/fold border-t py-1">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open/fold:rotate-180" />
      </summary>
      <div className="pb-3">{children}</div>
    </details>
  )
}

// 设定: description, persona and how it works. Saved as you leave a field (or
// tap a mode); nothing to submit.
function BotSettings({ bot, onBot }: { bot: Bot; onBot: (b: Bot) => void }) {
  const [f, setF] = useState({ description: bot.description, persona: bot.persona })
  useEffect(() => setF({ description: bot.description, persona: bot.persona }), [bot.id, bot.description, bot.persona])
  const save = async (patch: Partial<Bot>) => {
    if (Object.entries(patch).every(([k, v]) => bot[k as keyof Bot] === v)) return
    try {
      const r = await api<{ bot: Bot }>(`/api/bots/${bot.id}`, patch, 'PATCH')
      onBot({ ...bot, ...r.bot })
      botsChanged()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const mode = bot.mode ?? 'trusted'
  return (
    <div className="grid gap-3">
      <Input aria-label="一句话简介" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} onBlur={() => void save({ description: f.description.trim() })} placeholder="一句话简介" maxLength={120} className="min-h-11 text-base sm:text-sm" />
      <Textarea aria-label="人设" value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} onBlur={() => void save({ persona: f.persona.trim() })} rows={4} placeholder="人设：它是谁、怎么说话、要遵守什么" className="text-base sm:text-sm" />
      <div role="radiogroup" aria-label="做事方式" className="grid grid-cols-2 gap-2">
        {(
          [
            ['trusted', '直接做', '不打断你'],
            ['guarded', '先问我', '改文件、跑命令前先问'],
          ] as const
        ).map(([v, label, hint]) => (
          <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => void save({ mode: v })} className={`pressable min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${mode === v ? 'border-primary bg-primary/5' : 'text-muted-foreground'}`}>
            <div className="font-medium text-foreground">{label}</div>
            <div className="text-xs">{hint}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// Everything about a bot that is not the conversation: the one place for
// background work, goals, schedules, usage and the developer bits.
export function BotDetails({ open, onOpenChange, bot, onBot, advanced, onClosed }: { onClosed?: () => void; open: boolean; onOpenChange: (v: boolean) => void; bot: Bot | null; onBot: (b: Bot) => void; advanced: ReactNode }) {
  const pause = async (paused: boolean) => {
    if (!bot) return
    try {
      const r = await api<{ bot: Bot }>(`/api/bots/${bot.id}`, { paused }, 'PATCH')
      onBot({ ...bot, ...r.bot, paused })
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed() } }} side="right" className="w-full gap-0 overflow-y-auto pb-[max(env(safe-area-inset-bottom),16px)] sm:max-w-md">
        <SheetHeader className="items-center pt-8 text-center">
          {bot && <BotAvatar id={bot.id} className="size-16 shadow-soft" />}
          <SheetTitle className="text-lg">{bot?.name ?? '对话'}</SheetTitle>
          <SheetDescription>{bot?.description}</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          {bot && (
            <>
              <div className="flex min-h-14 items-center gap-3 border-t py-2">
                <label htmlFor="bot-pause" className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">暂停所有后台活动</span>
                  <span className="block text-xs text-muted-foreground">{bot.paused ? '已暂停：不检查目标，不跑定时任务' : '目标和定时任务照常进行'}</span>
                </label>
                <Switch id="bot-pause" checked={!!bot.paused} onCheckedChange={(v) => void pause(v)} aria-label="暂停所有后台活动" />
              </div>
              <Fold title="后台在做" open>
                <BotJobs botId={bot.id} />
              </Fold>
              <Fold title="历史">
                <BotHistory botId={bot.id} onOpen={() => onOpenChange(false)} />
              </Fold>
              <Fold title="目标">
                <BotGoals botId={bot.id} />
              </Fold>
              <Fold title="定时任务">
                <BotTasks botId={bot.id} />
              </Fold>
              <Fold title="设定">
                <BotSettings bot={bot} onBot={onBot} />
              </Fold>
            </>
          )}
          <Fold title="高级">{advanced}</Fold>
          {bot && bot.id !== ASSISTANT && (
            <div className="border-t pt-2">
              {bot.archived ? (
                <Button variant="ghost" className="min-h-11 w-full justify-start text-muted-foreground" onClick={() => void api<{ bot: Bot }>(`/api/bots/${bot.id}`, { archived: false }, 'PATCH').then((r) => (onBot({ ...bot, ...r.bot }), botsChanged(), toast.success('已恢复')), (e) => toast.error(errMsg(e)))}>
                  <ArchiveRestoreIcon /> 恢复
                </Button>
              ) : (
                <Button variant="ghost" className="min-h-11 w-full justify-start text-muted-foreground" onClick={() => void archiveBot(bot, () => (onOpenChange(false), go('#/')))}>
                  <ArchiveIcon /> 归档
                </Button>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
