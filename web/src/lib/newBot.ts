import { toast } from 'sonner'
import { api, errMsg } from './api'
import { botsChanged } from './bus'
import { go } from './route'
import type { Bot } from './types'

const LAST = 'pimu-last-dir'
// The folder you last gave a bot (详情 → 高级 or /cd): where the next one starts.
export const lastDir = () => {
  try {
    return localStorage.getItem(LAST) || ''
  } catch {
    return ''
  }
}
export const rememberDir = (cwd: string) => {
  try {
    localStorage.setItem(LAST, cwd)
  } catch {
    /* private mode */
  }
}

// '+' / ⌘N: a draft bot, straight into its empty chat. No name yet: the server
// keeps it out of the list until the first message names it.
let pending = false
export async function newBot() {
  if (pending) return
  pending = true
  const make = (cwd?: string) => api<{ bot: Bot }>('/api/bots', cwd ? { cwd } : {})
  try {
    const dir = lastDir()
    const r = await make(dir).catch((e) => (dir ? make() : Promise.reject(e))) // a remembered folder may be gone
    go(`#/s/${r.bot.id}`)
  } catch (e) {
    toast.error(errMsg(e))
  } finally {
    pending = false
  }
}

// Archive with an undo toast instead of a confirm.
export async function archiveBot(b: Bot, onDone?: () => void) {
  const set = (archived: boolean) => api<{ bot: Bot }>(`/api/bots/${b.id}`, { archived }, 'PATCH')
  try {
    await set(true)
    botsChanged()
    onDone?.()
    toast(`已归档「${b.name}」`, {
      action: {
        label: '撤销',
        onClick: () =>
          void set(false).then(
            () => (botsChanged(), go(`#/s/${b.id}`)),
            (e) => toast.error(errMsg(e)),
          ),
      },
    })
  } catch (e) {
    toast.error(errMsg(e))
  }
}
