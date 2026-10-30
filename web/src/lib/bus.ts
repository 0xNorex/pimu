import { motionOff as reduced } from './prefs'
// A session became a bot (bot: true) or stopped being one. The sidebar moves
// its row to the other tab with a shared-element transition.
export type BotsChanged = { id: string; bot: boolean }
export const BOTS_CHANGED = 'pimu:bots-changed'
export const botsChanged = (d: BotsChanged) => dispatchEvent(new CustomEvent<BotsChanged>(BOTS_CHANGED, { detail: d }))

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }

// Runs update inside a View Transition when the browser has one and motion is on.
export function transition(update: () => void, kind?: string) {
  const d = document as VTDoc
  if (!d.startViewTransition || reduced()) return update()
  if (kind) document.documentElement.dataset.vt = kind
  const t = d.startViewTransition(update)
  const done = () => {
    if (document.documentElement.dataset.vt === kind) delete document.documentElement.dataset.vt
  }
  t.ready.catch(() => {})
  t.finished.then(done, done) // a skipped transition rejects; .finally would rethrow it
}
