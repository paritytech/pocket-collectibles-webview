// Where purse ADDRESSES come from — one interface, two key sources.
//
// The scan in start.ts walks purse indexes 0..n; this seam answers "whose
// address is purse i". In a product-sdk container the HOST derives the
// key (product accounts under our DotNS name — the page never sees a
// secret, design doc §3.7, closing dependency #5 for container mode). In
// dev, the DEV_PHRASE deriver answers as before (devPurses.ts).

import { ss58Address } from '@polkadot-labs/hdkd-helpers'
import { getAccountsProvider } from '@parity/product-sdk-host'
import { DOTNS_IDENTIFIER } from './product'

export interface PurseSource {
  /** Stable identity for the scan-layout cache (pkt_purse_scan_v1:<key>). */
  cacheKey: string
  /** SS58 address (prefix 42) of the purse at `index`. */
  addressAt(index: number): Promise<string>
}

/** Container source: purse i is the host-derived product account at
 *  derivation index i. ONE instance per session — identity (product
 *  account 0) and the purse scan share the memo. Addresses are memoized —
 *  host round trips are not free and the gap-limit scan re-reads low
 *  indexes every poll — but a FAILED call is dropped so the next poll
 *  retries it.
 *
 *  Null when the capability is absent: outside a container, or in a host
 *  that doesn't implement product accounts — today's hosts don't, so the
 *  capability is PROBED once (index 0) and callers treat null as "mock
 *  with the dev derivation instead" (TEMPORARY stand-in; this seam is the
 *  swap point when hosts land the capability). */
let sessionSource: Promise<PurseSource | null> | null = null

export function hostPurseSource(): Promise<PurseSource | null> {
  if (!sessionSource) sessionSource = buildHostPurseSource()
  return sessionSource
}

async function buildHostPurseSource(): Promise<PurseSource | null> {
  const provider = await getAccountsProvider()
  if (!provider) return null
  const first = await provider.getProductAccount(DOTNS_IDENTIFIER, 0).match(
    (account) => ss58Address(account.publicKey, 42),
    () => null
  )
  if (!first) {
    console.warn('[chain] host has no product-account capability; using dev derivation instead')
    return null
  }
  const memo = new Map<number, Promise<string>>([[0, Promise.resolve(first)]])
  return {
    cacheKey: `host:${DOTNS_IDENTIFIER}`,
    addressAt(index) {
      let pending = memo.get(index)
      if (!pending) {
        pending = provider.getProductAccount(DOTNS_IDENTIFIER, index).match(
          (account) => ss58Address(account.publicKey, 42),
          (error) => {
            console.warn(`[chain] host refused product account ${index}`, error)
            throw new Error(`host refused product account ${index}`)
          }
        )
        memo.set(index, pending)
        pending.catch(() => {
          if (memo.get(index) === pending) memo.delete(index)
        })
      }
      return pending
    }
  }
}
