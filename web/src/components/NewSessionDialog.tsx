import { useEffect, useState, type FormEvent } from 'react'
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, FolderPlusIcon, HistoryIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, errMsg } from '@/lib/api'
import { shortPath } from '@/lib/format'
import { go } from '@/lib/route'

type Dirs = { path?: string; parent?: string; dirs: string[]; roots: string[]; recent: string[]; home: string }

// Anyone can ask for the picker; App mounts the single dialog.
export const openNewSession = (cwd?: string) => window.dispatchEvent(new CustomEvent('pimu:new-session', { detail: cwd }))

export function NewSessionDialog() {
  const [open, setOpen] = useState(false)
  const [d, setD] = useState<Dirs | null>(null)
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const browse = async (path: string) => {
    setErr('')
    try {
      const r = await api<Dirs>(`/api/dirs?path=${encodeURIComponent(path)}`)
      setD(r)
      setTyped(r.home ? shortPath(r.path ?? '', r.home) : (r.path ?? ''))
      return true
    } catch (e) {
      setErr(errMsg(e))
      // Snap the field back so it always shows the directory 在此开始 will use.
      if (d?.path) setTyped(shortPath(d.path, d.home))
      return false
    }
  }

  useEffect(() => {
    const on = (e: Event) => {
      const want = (e as CustomEvent<string | undefined>).detail
      setOpen(true)
      setNote('')
      setFolder(null)
      void api<Dirs>('/api/dirs').then(async (top) => {
        const start = want || top.recent[0] || top.roots[0]
        if (!start) return setErr('没有可用的工作目录，请设置 PIMU_WORKDIRS')
        if (!(await browse(start)) && want) {
          setNote(`${shortPath(want, top.home)} 不在允许的目录里，已换到默认目录。`)
          await browse(top.recent[0] || top.roots[0])
        }
      }, (e) => setErr(errMsg(e)))
    }
    window.addEventListener('pimu:new-session', on)
    return () => window.removeEventListener('pimu:new-session', on)
  }, [])

  const expand = (p: string) => (d?.home && (p === '~' || p.startsWith('~/')) ? d.home + p.slice(1) : p)
  const join = (name: string) => (d?.path === '/' ? '/' : (d?.path ?? '') + '/') + name

  const start = async () => {
    if (!d?.path) return
    setBusy(true)
    try {
      const r = await api<{ id: string }>('/api/sessions', { cwd: d.path })
      setOpen(false)
      go(`#/s/${r.id}`)
    } catch (e) {
      toast.error(errMsg(e), { id: 'new-session' })
    } finally {
      setBusy(false)
    }
  }
  const mkdir = async (e: FormEvent) => {
    e.preventDefault()
    if (!d?.path || !folder?.trim()) return
    try {
      const r = await api<{ path: string }>('/api/dirs', { path: d.path, name: folder.trim() })
      setFolder(null)
      await browse(r.path)
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const row = 'flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none'
  const others = d ? [...new Set([...d.recent, ...d.roots])].filter((p) => p !== d.path).slice(0, 6) : []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-3 p-0 sm:max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>新会话</DialogTitle>
          <DialogDescription>选一个工作目录；pi 会在这里读写文件、跑命令。</DialogDescription>
        </DialogHeader>
        <form
          className="flex items-center gap-1.5 px-5"
          onSubmit={(e) => {
            e.preventDefault()
            void browse(expand(typed.trim()))
          }}
        >
          <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" aria-label="上一级" disabled={!d?.parent} onClick={() => d?.parent && void browse(d.parent)}>
            <ArrowUpIcon />
          </Button>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="目录路径" className="h-9 font-mono text-[13px]" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </form>
        {(note || err) && <p className={`px-5 text-xs ${err ? 'text-destructive' : 'text-muted-foreground'}`} role={err ? 'alert' : undefined}>{err || note}</p>}
        <ScrollArea className="h-[min(48dvh,320px)] border-t">
          <div className="p-2">
            {!d && <Loader2Icon className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />}
            {d?.dirs.map((name) => (
              <button key={name} type="button" className={row} onClick={() => void browse(join(name))}>
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
              </button>
            ))}
            {d && d.dirs.length === 0 && <p className="px-2.5 py-3 text-sm text-muted-foreground">没有子目录</p>}
            {folder !== null ? (
              <form onSubmit={mkdir} className="flex items-center gap-1.5 px-1 pt-1">
                <Input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="文件夹名" aria-label="新文件夹名" className="h-9 text-sm" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setFolder(null))} />
                <Button type="submit" size="sm" className="h-9" disabled={!folder.trim()}>
                  创建
                </Button>
              </form>
            ) : (
              d?.path && (
                <button type="button" className={`${row} text-muted-foreground`} onClick={() => setFolder('')}>
                  <FolderPlusIcon className="size-4 shrink-0" /> 新建文件夹
                </button>
              )
            )}
            {others.length > 0 && (
              <>
                <p className="px-2.5 pt-3 pb-1 text-xs text-muted-foreground">最近与常用</p>
                {others.map((p) => (
                  <button key={p} type="button" className={row} onClick={() => void browse(p)}>
                    <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{shortPath(p, d?.home ?? '')}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="m-0 px-5 py-3">
          <Button variant="ghost" onClick={() => setOpen(false)} className="h-10 sm:h-9">
            取消
          </Button>
          <Button onClick={() => void start()} disabled={!d?.path || busy} className="h-10 sm:h-9">
            {busy && <Loader2Icon className="animate-spin" />}在此开始
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
