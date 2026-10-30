import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { api } from './api'

// Appearance and behaviour preferences. index.html's boot script reads the same
// localStorage key before first paint and mirrors the visual ones onto <html>
// as data-* attributes (CSS does the rest), so there is no flash on load.
// The server keeps a copy so other devices pick it up (newest `at` wins).
export type Prefs = {
  theme: 'system' | 'light' | 'dark'
  palette: 'paper' | 'neutral' | 'ocean' | 'forest' | 'rose' | 'contrast'
  font: 's' | 'm' | 'l'
  density: 'comfortable' | 'compact'
  width: 'narrow' | 'normal' | 'wide'
  radius: 'sharp' | 'normal' | 'round'
  motion: 'system' | 'full' | 'reduced' | 'off'
  mono: 'geist' | 'system'
  code: 'soft' | 'ink'
  texture: boolean
  thinking: boolean // thinking blocks open by default
  tools: boolean // tool groups open by default
  sendKey: 'enter' | 'mod'
  haptics: boolean
}
export const DEFAULTS: Prefs = {
  theme: 'system', palette: 'paper', font: 'm', density: 'comfortable', width: 'normal', radius: 'normal', motion: 'system',
  mono: 'geist', code: 'soft', texture: true, thinking: false, tools: false, sendKey: 'enter', haptics: false,
}
const KEY = 'pimu-prefs'
type Stored = { prefs: Partial<Prefs>; at: number }

function stored(): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Stored | null
    if (s?.prefs) return s
  } catch {
    /* corrupt: start over */
  }
  const legacy = localStorage.getItem('pimu-theme') as Prefs['theme'] | null // before V15
  return { prefs: legacy ? { theme: legacy } : {}, at: 0 }
}
const clean = (p: Partial<Prefs>) => {
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS) as (keyof Prefs)[]) if (p[k] !== undefined && typeof p[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = p[k]
  return out
}
let cur = clean(stored().prefs)
const subs = new Set<() => void>()
export const getPrefs = () => cur
export const usePrefs = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    getPrefs,
  )

let timer: ReturnType<typeof setTimeout> | undefined
const push = () => {
  clearTimeout(timer)
  timer = setTimeout(() => void api('/api/prefs', stored(), 'PUT').catch(() => {}), 500)
}

export function setPrefs(patch: Partial<Prefs>, at = Date.now(), sync = true) {
  cur = clean({ ...cur, ...patch })
  localStorage.setItem(KEY, JSON.stringify({ prefs: cur, at }))
  localStorage.removeItem('pimu-theme')
  dispatchEvent(new Event('pimu-prefs')) // boot script re-applies <html> attributes
  subs.forEach((f) => f())
  if (sync) push()
}

// Called once signed in (and when the tab comes back): adopt a newer copy from
// another device, or upload ours if the server's is older.
export async function pullPrefs() {
  const r = await api<Stored | { prefs: null; at: 0 }>('/api/prefs').catch(() => null)
  if (!r) return
  const local = stored().at
  if (r.prefs && r.at > local) setPrefs(r.prefs, r.at, false)
  else if (local > (r.at || 0)) push()
}

export const isDark = () => document.documentElement.classList.contains('dark')
export const motionOff = () => {
  const m = document.documentElement.dataset.motion
  if (m === 'full') return false
  if (m === 'off' || m === 'reduced') return true
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }

// Theme / palette changes reveal the new look as a circle growing from the
// control that was pressed (View Transitions; instant without them).
export function reveal(patch: Partial<Prefs>, from?: { clientX: number; clientY: number } | Element | null) {
  const d = document as VTDoc
  const apply = () => flushSync(() => setPrefs(patch))
  if (!d.startViewTransition || motionOff()) return apply()
  let x = innerWidth / 2
  let y = innerHeight / 2
  if (from instanceof Element) {
    const r = from.getBoundingClientRect()
    ;[x, y] = [r.left + r.width / 2, r.top + r.height / 2]
  } else if (from && (from.clientX || from.clientY)) [x, y] = [from.clientX, from.clientY]
  const html = document.documentElement
  html.dataset.vt = 'theme'
  const t = d.startViewTransition(apply)
  t.ready.then(() => {
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    html.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  }, () => {})
  // finished rejects when a newer transition skips this one; swallow it (no unhandled rejection)
  const done = () => {
    if (html.dataset.vt === 'theme') delete html.dataset.vt
  }
  t.finished.then(done, done)
}

// A tiny tap on Android when enabled; iOS Safari has no vibration API.
export const haptic = () => {
  if (cur.haptics) navigator.vibrate?.(8)
}
