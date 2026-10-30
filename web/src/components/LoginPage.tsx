import { useEffect, useState, type FormEvent } from 'react'
import { Loader2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errMsg } from '@/lib/api'
import { go } from '@/lib/route'

export type AuthStatus = { authed: boolean; via: 'access' | 'token' | ''; token: boolean; access: boolean }

export function LoginPage() {
  const [st, setSt] = useState<AuthStatus | null>(null)
  const [token, setToken] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    // Cloudflare Access already vouched for this browser: no token screen.
    api<AuthStatus>('/api/auth/status').then(
      (s) => (s.authed ? go('#/') : setSt(s)),
      () => setSt({ authed: false, via: '', token: true, access: false }),
    )
  }, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api('/api/login', { token })
      go('#/')
    } catch (e) {
      setErr(errMsg(e))
    }
  }
  if (!st) return <Loader2Icon className="m-auto size-5 animate-spin text-muted-foreground" aria-label="加载中" />
  return (
    <form onSubmit={submit} className="mx-auto flex h-full w-full max-w-sm flex-col justify-center gap-5 p-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Pimu</h1>
        <p className="mt-1 text-sm text-muted-foreground">Just Pi, everywhere.</p>
      </div>
      {st.token ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="token">访问令牌</Label>
            <Input id="token" type="password" autoComplete="current-password" placeholder="PIMU_TOKEN" value={token} onChange={(e) => setToken(e.target.value)} className="h-11 text-base" autoFocus />
            {st.access && <p className="text-xs text-muted-foreground">也可以通过 Cloudflare Access 的域名打开，免输令牌。</p>}
          </div>
          {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
          <Button type="submit" className="h-11" disabled={!token}>
            登录
          </Button>
        </>
      ) : (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground" role="alert">
          这个 Pimu 只接受 Cloudflare Access 登录。请从 Access 保护的域名打开；如果已经打开了，刷新一下让 Access 重新签发凭证。
        </p>
      )}
    </form>
  )
}
