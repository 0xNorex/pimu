import { Toaster } from '@/components/ui/sonner'
import { lazy, Suspense, useSyncExternalStore } from 'react'
import { LoginPage } from '@/components/LoginPage'
import { Switcher } from '@/components/Switcher'
import { BotList } from '@/components/BotList'
import { NewSessionDialog } from '@/components/NewSessionDialog'
import { SECTIONS, type Section } from '@/lib/sections'

// Pages load on demand so the home list (the phone's first screen) stays small.
const ChatView = lazy(() => import('@/components/ChatView').then((m) => ({ default: m.ChatView })))
const SettingsPage = lazy(() => import('@/components/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const TaskDetail = lazy(() => import('@/components/TaskDetail').then((m) => ({ default: m.TaskDetail })))
const TasksPage = lazy(() => import('@/components/TasksPage').then((m) => ({ default: m.TasksPage })))
const InboxPage = lazy(() => import('@/components/InboxPage').then((m) => ({ default: m.InboxPage })))
import { useHashRoute } from '@/lib/route'

const wideQ = typeof matchMedia !== 'undefined' ? matchMedia('(min-width: 1024px)') : undefined
const useWide = () =>
  useSyncExternalStore(
    (cb) => (wideQ?.addEventListener('change', cb), () => wideQ?.removeEventListener('change', cb)),
    () => !!wideQ?.matches,
  )

export default function App() {
  const wide = useWide()
  const route = useHashRoute()
  const activeId = route.name === 'session' ? route.id : undefined
  const page =
    route.name === 'session' ? (
      <ChatView key={route.id} id={route.id} />
    ) : route.name === 'tasks' ? (
      <TasksPage />
    ) : route.name === 'inbox' ? (
      <InboxPage />
    ) : route.name === 'task' ? (
      <TaskDetail key={route.id} id={route.id} bot={route.bot} />
    ) : route.name === 'settings' ? (
      <SettingsPage section={(SECTIONS.some(([k]) => k === route.section) ? route.section : 'models') as Section} />
    ) : null
  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      {route.name === 'login' ? (
        <LoginPage />
      ) : (
        <>
          <aside className={`${page ? 'hidden' : 'flex'} w-full flex-col lg:flex lg:w-[340px] lg:shrink-0 lg:border-r lg:bg-sidebar`}>
            <BotList activeId={activeId} route={route.name} />
          </aside>
          {page ? <Suspense fallback={<main className="flex-1" />}>{page}</Suspense> : (
            <main className="hidden flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground lg:flex">
              <p className="font-medium text-foreground">没有打开的会话</p>
              <p>从左边选一个，或按 ⌘K 搜索</p>
            </main>
          )}
        </>
      )}
      {route.name !== 'login' && <Switcher />}
      {route.name !== 'login' && <NewSessionDialog />}
      {/* Desktop: out of the way, bottom-right. Phone: top, below the header, clear of the composer. */}
      <Toaster position={wide ? 'bottom-right' : 'top-center'} visibleToasts={3} mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 60px)' }} />
    </div>
  )
}
