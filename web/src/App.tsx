import { Toaster } from '@/components/ui/sonner'
import { ChatView } from '@/components/ChatView'
import { LoginPage } from '@/components/LoginPage'
import { SessionList } from '@/components/SessionList'
import { useHashRoute } from '@/lib/route'

export default function App() {
  const route = useHashRoute()
  const activeId = route.name === 'session' ? route.id : undefined
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {route.name === 'login' ? (
        <LoginPage />
      ) : (
        <>
          <aside className={`${activeId ? 'hidden' : 'flex'} w-full flex-col lg:flex lg:w-[280px] lg:shrink-0 lg:border-r`}>
            <SessionList activeId={activeId} />
          </aside>
          {activeId ? (
            <ChatView key={activeId} id={activeId} />
          ) : (
            <main className="hidden flex-1 items-center justify-center text-sm text-muted-foreground lg:flex">选择或新建一个会话</main>
          )}
        </>
      )}
      <Toaster position="top-center" />
    </div>
  )
}
