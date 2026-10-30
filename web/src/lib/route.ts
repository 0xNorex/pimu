import { useEffect, useState } from 'react'

export type Route =
  | { name: 'login' }
  | { name: 'list' }
  | { name: 'session'; id: string }
  | { name: 'tasks' }
  | { name: 'task'; id: number | 'new'; bot?: string }
  | { name: 'memory' }

function parse(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (h === '/login') return { name: 'login' }
  const m = h.match(/^\/s\/([\w-]+)$/)
  if (m) return { name: 'session', id: m[1] }
  if (h === '/tasks') return { name: 'tasks' }
  if (h === '/memory') return { name: 'memory' }
  const t = h.match(/^\/tasks\/(new|\d+)(?:\?bot=([\w-]+))?$/)
  if (t) return { name: 'task', id: t[1] === 'new' ? 'new' : Number(t[1]), bot: t[2] }
  return { name: 'list' }
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const go = (hash: string) => {
  location.hash = hash
}
