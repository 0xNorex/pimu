import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errMsg } from '@/lib/api'
import { go } from '@/lib/route'

export function LoginPage() {
  const [token, setToken] = useState('')
  const [err, setErr] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api('/api/login', { token })
      go('#/')
    } catch (e) {
      setErr(errMsg(e))
    }
  }
  return (
    <form onSubmit={submit} className="mx-auto flex h-full max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Pimu</h1>
      <p className="text-sm text-muted-foreground">Just Pi, everywhere.</p>
      <div className="grid gap-2">
        <Label htmlFor="token">PIMU_TOKEN</Label>
        <Input id="token" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} className="min-h-11 text-base" autoFocus />
      </div>
      {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
      <Button type="submit" className="min-h-11" disabled={!token}>
        登录
      </Button>
    </form>
  )
}
