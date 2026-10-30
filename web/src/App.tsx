import { Toaster } from '@/components/ui/sonner'
import { ChatView } from '@/components/ChatView'
import { LoginPage } from '@/components/LoginPage'
import { MemoryPage } from '@/components/MemoryPage'
import { SessionList } from '@/components/SessionList'
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
      <TaskDetail key={route.id} id={route.id} />
    ) : route.name === 'memory' ? (
      <MemoryPage />
    ) : null
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {route.name === 'login' ? (
        <LoginPage />
      ) : (
        <>
          <aside className={`${page ? 'hidden' : 'flex'} w-full flex-col lg:flex lg:w-[280px] lg:shrink-0 lg:border-r`}>
            <SessionList activeId={activeId} route={route.name} />
          </aside>
          {page ?? (
            <main className="hidden flex-1 items-center justify-center text-sm text-muted-foreground lg:flex">选择或新建一个会话</main>
          )}
        </>
      )}
      <Toaster position="top-center" />
    </div>
  )
}
