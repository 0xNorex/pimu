import { useEffect, useState } from 'react'

// Quiet by design: a dropped stream reconnects by itself, so say so only when
// it takes longer than a moment.
export function ConnectionBanner({ connected, lock }: { connected: boolean; lock: string }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (connected) return setSlow(false)
    const t = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(t)
  }, [connected])
  if (lock === 'external')
    return (
      <div className="bg-amber-500/15 px-3 py-1.5 text-center text-xs text-amber-800 dark:text-amber-300" role="status">
        这个对话正在终端里使用，退出终端后就能继续。
      </div>
    )
  if (!connected && slow)
    return (
      <div className="px-3 py-1 text-center text-xs text-muted-foreground" role="status" data-reconnecting>
        正在重新连接…
      </div>
    )
  return null
}
