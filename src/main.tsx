import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'
import { installDiagnostics } from './diag'
import { startChainSync } from './chain/start'

installDiagnostics()

// Primary data source: read owned NFTs from Asset Hub. Fire-and-forget —
// never blocks first paint; the collection store picks up whatever arrives
// first (cache seed -> chain -> native push, last write wins). Inert when
// there's no chain connection (see chain/start.ts).
startChainSync()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found in index.html')

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
