import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'
import './themes.css'
import { installDiagnostics } from './diag'
// Side-effect import: registers window.deliverRequestUpdate before React
// mounts, so a fast native (or mock) response is buffered, never dropped —
// same discipline as the collection channel.
import './bridge/requests'
import { installMockNative } from './mock/mockNative'

installDiagnostics()

// Design variations, keyed off the URL (?theme=<name>). Applied to <html>
// before React mounts so the first paint is already themed — no flash of
// the default look. Unknown values fall through to the default
// dark-ethereal theme. See src/themes.css; the on-screen ThemeSwitcher
// flips the same attribute live.
{
  const theme = new URLSearchParams(window.location.search).get('theme')
  if (theme && ['gilded', 'arcana', 'loot', 'pixel'].includes(theme)) {
    document.documentElement.dataset.theme = theme
  }
}

// Dev/mock sessions get a fake native host that answers bridge requests
// (and narrates, in comments, what the real one will do). A real WebView
// host always wins: install is a no-op when its transport already exists.
if (/[?&](dev=1|mock=)/.test(window.location.search)) {
  installMockNative()
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found in index.html')

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
