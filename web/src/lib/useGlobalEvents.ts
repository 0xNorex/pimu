import { useEffect, useRef } from 'react'
import type { GlobalEvent } from './types'

// Follows /api/events (run_update, proc_state). EventSource reconnects by itself;
// on reconnect we report a resync so callers refetch.
export function useGlobalEvents(on: (e: GlobalEvent) => void) {
  const ref = useRef(on)
  ref.current = on
  useEffect(() => {
    const es = new EventSource('/api/events')
    let opened = false
    es.onopen = () => {
      if (opened) ref.current({ type: 'resync' })
      opened = true
    }
    es.addEventListener('pimu', (m) => ref.current(JSON.parse(m.data) as GlobalEvent))
    return () => es.close()
  }, [])
}
