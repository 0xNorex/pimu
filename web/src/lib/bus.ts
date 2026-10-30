// A session became a bot (bot: true) or stopped being one. The sidebar moves
// its row to the other tab with a shared-element transition.
export type BotsChanged = { id: string; bot: boolean }
export const BOTS_CHANGED = 'pimu:bots-changed'
export const botsChanged = (d: BotsChanged) => dispatchEvent(new CustomEvent<BotsChanged>(BOTS_CHANGED, { detail: d }))

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Runs update inside a View Transition when the browser has one and motion is on.
export function transition(update: () => void, kind?: string) {
  const d = document as VTDoc
  if (!d.startViewTransition || reduced()) return update()
  if (kind) document.documentElement.dataset.vt = kind
  const t = d.startViewTransition(update)
  t.finished.finally(() => {
    if (document.documentElement.dataset.vt === kind) delete document.documentElement.dataset.vt
  })
}
