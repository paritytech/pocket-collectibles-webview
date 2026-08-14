// The dev connection path: direct WebSockets to the gaming testnet.
// Used outside any host, and (TEMPORARILY) as the container fallback while
// no host build serves the gamingnet chains — see client.ts, the seam that
// decides which path a session gets. Never used inside a legacy embedded
// host without an explicit ?player= override.

import { createClient } from 'polkadot-api'
import { getWsProvider } from 'polkadot-api/ws'
import { gamingnetAssetHub, gamingnetPeople } from '@polkadot-api/descriptors'
import type { ChainApis } from './client'

/** Gaming testnet endpoints. Dev fallback only — never used inside a
 *  host of any kind. */
export const TESTNET_WS = {
  assetHub: 'wss://gamingnet.substrate.dev/asset-hub', // spec: next-asset-hub-paseo
  people: 'wss://gamingnet.substrate.dev/people' // spec: Individuality Local
} as const

type DevClient = ReturnType<typeof createClient>
const devClients = new Map<keyof typeof TESTNET_WS, DevClient>()

function devClient(chain: keyof typeof TESTNET_WS): DevClient {
  let client = devClients.get(chain)
  if (!client) {
    client = createClient(getWsProvider(TESTNET_WS[chain]))
    devClients.set(chain, client)
  }
  return client
}

/** Typed apis over the direct testnet sockets, one lazy client per chain. */
export function devApis(): ChainApis {
  return {
    assetHub: devClient('assetHub').getTypedApi(gamingnetAssetHub),
    people: devClient('people').getTypedApi(gamingnetPeople)
  }
}

/** Tear down the dev clients so the next call rebuilds them fresh. */
export function destroyDevClients(): void {
  for (const client of devClients.values()) {
    try { client.destroy() } catch { /* already torn down */ }
  }
  devClients.clear()
}
