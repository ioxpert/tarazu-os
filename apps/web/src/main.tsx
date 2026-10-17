import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { initI18n } from './i18n'
import './index.css'

registerSW({ immediate: true })

// The sync runtime (PowerSync + SQLite WASM) is a separate lazy chunk started by AppProvider for a configured
// device, so unregistered visitors and the first paint never pay for it.
void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
