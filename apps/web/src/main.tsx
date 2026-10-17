import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { hasSyncConfig } from './sync/config'
import './index.css'

registerSW({ immediate: true })

// A configured device starts syncing in the background. The runtime (PowerSync + SQLite WASM) is a separate
// lazy chunk, so unregistered visitors and the first paint never pay for it.
if (hasSyncConfig()) void import('./sync/runtime').then((m) => m.getSyncRuntime()).catch((e) => console.warn('sync not started', e))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
