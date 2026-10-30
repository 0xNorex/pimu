export type Theme = 'system' | 'light' | 'dark'

export const getTheme = (): Theme => (localStorage.getItem('pimu-theme') as Theme) || 'system'

// index.html owns applying the class; this just stores the choice and pings it.
export function setTheme(t: Theme) {
  if (t === 'system') localStorage.removeItem('pimu-theme')
  else localStorage.setItem('pimu-theme', t)
  window.dispatchEvent(new Event('pimu-theme'))
}

// A tiny tap on Android; iOS Safari has no vibration API, so it's a no-op there.
export const haptic = () => navigator.vibrate?.(8)
