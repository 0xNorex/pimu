import { useEffect, useState } from 'react'

export type Route = { name: 'login' } | { name: 'list' } | { name: 'session'; id: string }

function parse(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (h === '/login') return { name: 'login' }
  const m = h.match(/^\/s\/([\w-]+)$/)
  if (m) return { name: 'session', id: m[1] }
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
