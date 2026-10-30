// Per-device "read up to" marks for the unread dot (localStorage, no server state).
const key = (id: string) => `pimu.seen.${id}`

export const markSeen = (id: string) => localStorage.setItem(key(id), String(Date.now()))

export const isUnread = (id: string, updatedAt: string) => {
  const seen = Number(localStorage.getItem(key(id)) || 0)
  return Date.parse(updatedAt) > seen + 1000
}
