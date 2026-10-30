export function ConnectionBanner({ connected, lock }: { connected: boolean; lock: string }) {
  if (lock === 'external')
    return (
      <div className="bg-amber-500/15 px-3 py-1.5 text-center text-xs text-amber-800 dark:text-amber-300" role="status">
        终端 pi 正在使用此会话（只读）。在终端退出 pi 后即可继续。
      </div>
    )
  if (!connected)
    return (
      <div className="bg-muted px-3 py-1 text-center text-xs text-muted-foreground" role="status">
        重新连接中…
      </div>
    )
  return null
}
