import { Toaster } from '@/components/ui/sonner'
import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { LoginPage } from '@/components/LoginPage'
import { Switcher } from '@/components/Switcher'
import { BotList } from '@/components/BotList'
import { NewSessionDialog, quickNewSession } from '@/components/NewSessionDialog'
import { SquarePenIcon } from 'lucide-react'
import { SECTIONS, type Section } from '@/lib/sections'

// Pages load on demand so the home list (the phone's first screen) stays small.
// Once fetched, the chat renders directly: a lazy() would suspend for a tick and the phone's slide-in would show a blank frame.
let chatMod: typeof import('@/components/ChatView') | undefined
const loadChat = () => import('@/components/ChatView').then((m) => (chatMod = m))
const LazyChat = lazy(() => loadChat().then((m) => ({ default: m.ChatView })))
const SettingsPage = lazy(() => import('@/components/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const TaskDetail = lazy(() => import('@/components/TaskDetail').then((m) => ({ default: m.TaskDetail })))
const TasksPage = lazy(() => import('@/components/TasksPage').then((m) => ({ default: m.TasksPage })))
const InboxPage = lazy(() => import('@/components/InboxPage').then((m) => ({ default: m.InboxPage })))
import { useHashRoute } from '@/lib/route'
import { pullPrefs } from '@/lib/prefs'

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
  // Fetch the chat chunk once the list is idle, so opening a chat (and its slide-in) has no blank frame.
  useEffect(() => {
    const t = setTimeout(() => void loadChat().catch(() => {}), 1200)
    return () => clearTimeout(t)
  }, [])
  // Appearance follows you across devices: adopt the server's copy if newer (and when the tab returns).
  const signedIn = route.name !== 'login'
  useEffect(() => {
    if (!signedIn) return
    void pullPrefs()
    const on = () => document.visibilityState === 'visible' && void pullPrefs()
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [signedIn])
  const page =
    route.name === 'session' ? (
      chatMod ? <chatMod.ChatView key={route.id} id={route.id} /> : <LazyChat key={route.id} id={route.id} />
    ) : route.name === 'tasks' ? (
      <TasksPage />
    ) : route.name === 'inbox' ? (
      <InboxPage />
    ) : route.name === 'task' ? (
      <TaskDetail key={route.id} id={route.id} bot={route.bot} />
    ) : route.name === 'settings' ? (
      <SettingsPage section={(SECTIONS.some(([k]) => k === route.section) ? route.section : 'home') as Section} />
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
            <main className="hidden flex-1 flex-col items-center justify-center text-sm text-muted-foreground lg:flex">
              <span className="brand-mark idle-mark mb-5 size-12! rounded-2xl!" aria-hidden />
              <p className="font-heading text-base font-semibold text-foreground">没有打开的会话</p>
              <p className="mt-1">从左边选一个 Bot 或会话</p>
              <div className="mt-5 flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5"><kbd className="rounded border bg-card px-1.5 py-0.5 font-mono text-[11px]">⌘K</kbd> 搜索</span>
                <button type="button" className="pressable flex min-h-9 items-center gap-1.5 rounded-md px-2 hover:bg-foreground/[0.05] hover:text-foreground" onClick={() => void quickNewSession()}>
                  <SquarePenIcon className="size-3.5" /> 新会话
                </button>
              </div>
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
