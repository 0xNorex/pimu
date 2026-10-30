import { cn } from 'cn'

export function BotAvatar({ emoji, className }: { emoji: string; className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-2xl leading-none', className)}>
      {emoji || '🤖'}
    </span>
  )
}
