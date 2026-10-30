import { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { UIRequest } from '@/lib/types'

type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean }

function Countdown({ ms }: { ms?: number }) {
  const [left, setLeft] = useState(ms ? Math.ceil(ms / 1000) : 0)
  useEffect(() => {
    if (!ms) return
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000)
    return () => clearInterval(t)
  }, [ms])
  return ms ? <span className="text-xs text-muted-foreground">{left}s 后自动取消</span> : null
}

export function ExtensionDialog({ req, onReply }: { req: UIRequest; onReply: (r: Reply) => void }) {
  const [value, setValue] = useState(req.prefill ?? '')
  const cancel = () => onReply({ cancelled: true })

  if (req.method === 'confirm') {
    return (
      <AlertDialog open onOpenChange={(o) => !o && cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{req.title}</AlertDialogTitle>
            {req.message && <AlertDialogDescription className="whitespace-pre-wrap">{req.message}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Countdown ms={req.timeout} />
            <AlertDialogCancel onClick={() => onReply({ confirmed: false })}>否</AlertDialogCancel>
            <AlertDialogAction onClick={() => onReply({ confirmed: true })}>是</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }
  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
          {req.message ? <DialogDescription>{req.message}</DialogDescription> : <DialogDescription className="sr-only">扩展请求</DialogDescription>}
        </DialogHeader>
        {req.method === 'select' ? (
          <div className="flex flex-col gap-2">
            {req.options?.map((o) => (
              <Button key={o} variant="outline" className="min-h-11 justify-start" onClick={() => onReply({ value: o })}>
                {o}
              </Button>
            ))}
          </div>
        ) : (
          <Textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder={req.placeholder} className="min-h-24 text-base" autoFocus />
        )}
        <DialogFooter className="items-center">
          <Countdown ms={req.timeout} />
          <Button variant="outline" onClick={cancel}>取消</Button>
          {req.method !== 'select' && <Button onClick={() => onReply({ value })}>确定</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
