import { Toaster } from '@/components/ui/sonner'
import { ChatView } from '@/components/ChatView'
import { LoginPage } from '@/components/LoginPage'
import { SECTIONS, SettingsPage, type Section } from '@/components/SettingsPage'
import { Switcher } from '@/components/Switcher'
import { BotList } from '@/components/BotList'
import { TaskDetail } from '@/components/TaskDetail'
import { TasksPage } from '@/components/TasksPage'
import { useHashRoute } from '@/lib/route'

export default function App() {
  const route = useHashRoute()
  const activeId = route.name === 'session' ? route.id : undefined
  const page =
    route.name === 'session' ? (
      <ChatView key={route.id} id={route.id} />
    ) : route.name === 'tasks' ? (
      <TasksPage />
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
          {page ?? (
            <main className="hidden flex-1 items-center justify-center text-sm text-muted-foreground lg:flex">选一个会话，或点 + 开个新的</main>
          )}
        </>
      )}
      {route.name !== 'login' && <Switcher />}
      <Toaster position="top-center" />
    </div>
  )
}
