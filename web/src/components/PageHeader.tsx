import type { ReactNode } from 'react'
import { ChevronLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Shared 56px top bar (same as the chat header); the back button hides on desktop
// when the sidebar is visible. `flush` drops the rule when a tab strip follows.
export function PageHeader({ title, back, backAlways, flush, children }: { title: ReactNode; back: string; backAlways?: boolean; flush?: boolean; children?: ReactNode }) {
  return (
    <header className={`z-10 box-content flex h-14 shrink-0 items-center gap-1 bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl ${flush ? '' : 'border-b'} ${backAlways ? '' : 'lg:px-3'}`}>
      <Button asChild size="icon" variant="ghost" className={`size-10 ${backAlways ? 'lg:size-9' : 'lg:hidden'}`} aria-label="返回">
        <a href={back}>
          <ChevronLeftIcon />
        </a>
      </Button>
      <h1 className="min-w-0 flex-1 truncate pl-1 text-[15px] font-semibold tracking-tight">{title}</h1>
      {children}
    </header>
  )
}
