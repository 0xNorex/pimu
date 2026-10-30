import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import App from './App.tsx'
import './index.css'

// iOS Safari doesn't shrink the layout viewport for the keyboard; track the visual
// viewport so the composer stays above it (no-op elsewhere: heights match).
const vv = window.visualViewport
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`)
    if (vv.offsetTop > 0) window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
  fit()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Service worker caches only the app shell; a new version waits until the user refreshes.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const offer = (w: ServiceWorker) =>
      toast('Pimu 有新版本', { duration: Infinity, action: { label: '刷新', onClick: () => w.postMessage('skipWaiting') } })
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting)
    reg.addEventListener('updatefound', () => {
      const w = reg.installing
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w)
      })
    })
  })
  let reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloaded) {
      reloaded = true
      location.reload()
    }
  })
}
