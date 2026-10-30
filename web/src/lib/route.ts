import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { transition } from './bus'

export type Route =
  | { name: 'login' }
  | { name: 'list' }
  | { name: 'session'; id: string }
  | { name: 'tasks' }
  | { name: 'inbox' }
  | { name: 'task'; id: number | 'new'; bot?: string }
  | { name: 'settings'; section: string }

function parse(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (h === '/login') return { name: 'login' }
  const m = h.match(/^\/s\/([\w-]+)$/)
  if (m) return { name: 'session', id: m[1] }
  if (h === '/tasks') return { name: 'tasks' }
  if (h === '/inbox') return { name: 'inbox' }
  if (h === '/memory') return { name: 'settings', section: 'memory' }
  const st = h.match(/^\/settings(?:\/(\w+))?$/)
  if (st) return { name: 'settings', section: st[1] ?? 'appearance' }
  const t = h.match(/^\/tasks\/(new|\d+)(?:\?bot=([\w-]+))?$/)
  if (t) return { name: 'task', id: t[1] === 'new' ? 'new' : Number(t[1]), bot: t[2] }
  return { name: 'list' }
}

// How deep a page sits: shallower is "back" (pop), deeper or sideways is "push".
const depth = (r: Route) => (r.name === 'list' ? 0 : r.name === 'task' ? 2 : 1)
const narrow = () => typeof matchMedia !== 'undefined' && !matchMedia('(min-width: 1024px)').matches

export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  const cur = useRef(route)
  useEffect(() => {
    // Phone: going deeper slides the new page in from the right; going back slides it away.
    const on = () => {
      const next = parse(location.hash)
      const prev = cur.current
      cur.current = next
      const apply = () => flushSync(() => setRoute(next))
      if (!narrow() || next.name === 'login' || prev.name === 'login' || (prev.name === next.name && next.name !== 'session')) return apply()
      transition(apply, depth(next) < depth(prev) ? 'pop' : 'push')
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const go = (hash: string) => {
  location.hash = hash
}
