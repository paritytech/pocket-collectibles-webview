// Lazy polkadot-api client singletons, one per chain, over whatever
// provider the session resolved (host seam or dev WebSocket). The
// descriptorless unsafe API is narrowed to the read surfaces documented
// in scarcity.ts (Asset Hub) and credits.ts (People Chain).

import { createClient } from 'polkadot-api'
import { getChainProvider, type ChainId } from './provider'

type Client = ReturnType<typeof createClient>

const clients = new Map<ChainId, Client>()

/** The unsafe API for `chain`, or null when the session has no provider
 *  for it. Callers cast to their documented read-surface interface. */
export function getChainApi(chain: ChainId): unknown | null {
  let client = clients.get(chain)
  if (!client) {
    const provider = getChainProvider(chain)
    if (!provider) return null
    client = createClient(provider)
    clients.set(chain, client)
  }
  return client.getUnsafeApi()
}

export function destroyClients(): void {
  for (const client of clients.values()) {
    try { client.destroy() } catch { /* already torn down */ }
  }
  clients.clear()
}
