import type { ReactNode } from 'react'
import { ChevronDownIcon, PencilIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api, errMsg } from '@/lib/api'
import type { Bot } from '@/lib/types'
import { BotAvatar } from './BotAvatar'
import { BotGoals } from './BotGoals'
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

// Everything about a bot that is not the conversation: the one place for
// background work, goals, schedules, usage and the developer bits.
export function BotDetails({ open, onOpenChange, bot, onBot, onEdit, advanced, onClosed }: { onClosed?: () => void; open: boolean; onOpenChange: (v: boolean) => void; bot: Bot | null; onBot: (b: Bot) => void; onEdit: () => void; advanced: ReactNode }) {
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
          <SheetDescription>{bot?.description || (bot ? '' : '普通对话')}</SheetDescription>
          <Button variant="outline" size="sm" className="mt-1 min-h-9" onClick={onEdit}>
            <PencilIcon /> {bot ? '编辑' : '设为 Bot'}
          </Button>
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
              <Fold title="目标">
                <BotGoals botId={bot.id} />
              </Fold>
              <Fold title="定时任务">
                <BotTasks botId={bot.id} />
              </Fold>
            </>
          )}
          <Fold title="高级">{advanced}</Fold>
        </div>
      </SheetContent>
    </Sheet>
  )
}
