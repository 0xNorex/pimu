import { useEffect, useRef } from 'react'
import type { GlobalEvent } from './types'

// Follows /api/events (run_update, proc_state, …). One shared EventSource for
// the whole tab: browsers allow ~6 HTTP/1.1 connections per host, and one
// stream per subscriber starved ordinary requests once a few panels were open.
// EventSource reconnects by itself; on reconnect subscribers get a resync.
type Fn = (e: GlobalEvent) => void
const subs = new Set<{ current: Fn }>()
let es: EventSource | null = null

function emit(e: GlobalEvent) {
  for (const s of [...subs]) s.current(e)
}

function connect() {
  let opened = false
  es = new EventSource('/api/events')
  es.onopen = () => {
    if (opened) emit({ type: 'resync' } as GlobalEvent)
    opened = true
  }
  es.addEventListener('pimu', (m) => emit(JSON.parse((m as MessageEvent).data) as GlobalEvent))
}

export function useGlobalEvents(on: Fn) {
  const ref = useRef(on)
  ref.current = on
  useEffect(() => {
    subs.add(ref)
    if (!es) connect()
    return () => {
      subs.delete(ref)
      if (!subs.size) {
        es?.close()
        es = null
      }
    }
  }, [])
}
