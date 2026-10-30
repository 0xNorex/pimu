import { useEffect, useRef, useState, type Dispatch } from 'react'
import { toast } from 'sonner'
import { api } from './api'
import type { Action } from './store'
import type { Incoming, Message, PiEvent, PimuEvent, SessionDetail } from './types'

// Loads messages, then follows the SSE stream from the returned seq.
// Deltas are batched per animation frame. Reloads on resync and on return to foreground.
export function useSessionEvents(id: string, dispatch: Dispatch<Action>, onDetail: (d: SessionDetail) => void) {
  const [connected, setConnected] = useState(true)
  const detailRef = useRef(onDetail)
  detailRef.current = onDetail

  useEffect(() => {
    let es: EventSource | null = null
    let buf: Incoming[] = []
    let frame = 0
    let alive = true
    let retry = 0

    const flush = () => {
      frame = 0
      const events = buf
      buf = []
      if (events.length) dispatch({ type: 'events', events })
    }
    const push = (ev: Incoming) => {
      buf.push(ev)
      if (!frame) frame = requestAnimationFrame(flush)
    }

    const connect = async () => {
      es?.close()
      try {
        const [msgs, detail] = await Promise.all([
          api<{ messages: Message[] | null; seq: number }>(`/api/sessions/${id}/messages`),
          api<SessionDetail>(`/api/sessions/${id}`),
        ])
        if (!alive) return
        buf = []
        detailRef.current(detail)
        dispatch({ type: 'load', messages: msgs.messages ?? [], streaming: !!detail.state?.isStreaming })
        es = new EventSource(`/api/sessions/${id}/events?since=${msgs.seq}`)
        es.onopen = () => setConnected(true)
        es.onerror = () => {
          setConnected(false)
          if (es?.readyState === EventSource.CLOSED) retry = window.setTimeout(connect, 3000)
        }
        es.addEventListener('pi', (m) => {
          const data = JSON.parse(m.data) as PiEvent
          // Extensions chatter ("… loaded") at info level; only warnings and errors
          // reach the user, once per distinct message.
          if (data.type === 'extension_ui_request' && data.method === 'notify' && data.message && (data.notifyType === 'error' || data.notifyType === 'warning')) {
            ;(data.notifyType === 'error' ? toast.error : toast.warning)(data.message, { id: `ext:${data.message}` })
          }
          push({ kind: 'pi', data })
        })
        es.addEventListener('pimu', (m) => {
          const data = JSON.parse(m.data) as PimuEvent
          if (data.type === 'resync') {
            void connect()
            return
          }
          push({ kind: 'pimu', data })
        })
      } catch {
        setConnected(false)
        if (alive) retry = window.setTimeout(connect, 3000)
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void connect()
    }
    void connect()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      es?.close()
      cancelAnimationFrame(frame)
      clearTimeout(retry)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [id, dispatch])

  return connected
}
