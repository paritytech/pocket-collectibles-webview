import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'
import { installDiagnostics } from './diag'
import { initIdentity } from './chain/identity'
import { startChainSync } from './chain/start'

installDiagnostics()

// The only data source: read owned NFTs + credits from chain. Identity
// resolves first (in a container it's a host round trip; in dev a sync
// param read) so the first poll reads the right shelf. Fire-and-forget —
// never blocks first paint; the collection store picks up whatever arrives
// first (cache seed -> chain, last write wins). Inert when there's no
// chain connection (see chain/start.ts).
void (async () => {
  await initIdentity()
  startChainSync()
})()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found in index.html')

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
