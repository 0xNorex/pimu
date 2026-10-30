import type { ReactNode } from 'react'
import { ChevronLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Shared top bar for non-chat pages; the back button hides on desktop when the sidebar is visible.
export function PageHeader({ title, back, backAlways, children }: { title: ReactNode; back: string; backAlways?: boolean; children?: ReactNode }) {
  return (
    <header className="z-10 flex items-center gap-1 border-b bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <Button asChild size="icon" variant="ghost" className={`size-11 ${backAlways ? '' : 'lg:hidden'}`} aria-label="返回">
        <a href={back}>
          <ChevronLeftIcon />
        </a>
      </Button>
      <h1 className="min-w-0 flex-1 truncate py-3 pl-1 text-base font-semibold">{title}</h1>
      {children}
    </header>
  )
}
