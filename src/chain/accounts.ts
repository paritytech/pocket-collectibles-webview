// Which purse addresses to read.
//
/*
* TEMPORARY SOLUTION TO OPEN QUESTION
* DEPENDENCY #5/#6
* https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
*
* Which accounts collectibles land at, and what host call returns the
* list a product may see. Until then this module is an injectable seam
* (sources 1-3 below) with the dev-only deriver as fallback.
*
*/
//
// pallet-scarcity holds at most one NFT per account, so "the player's
// collection" is defined by the list of purse addresses they control.
// WHO decides that list is an open product question (the account-derivation
// convention isn't settled). This module isolates the answer behind
// AccountSource so the production rule slots in without touching the sync
// loop.
//
// Resolution order at load:
//   1. ?address=<ss58>[,<ss58>...] query param — dev/QA; persisted so a
//      plain reload keeps showing the same shelf
//   2. window.__ACCOUNTS__ set before our JS ran — the future production
//      seam, same discipline as __COLLECTION__
//   3. addresses persisted by a previous session
//   4. nothing — the sync loop (start.ts) then gap-scans the purse
//      subtree of the dev root the player identity maps to. Dev-only
//      until a host supplies public keys; an explicit source (1–3, or a
//      later setAccounts) always wins over it.
// At any later point native may call window.setAccounts([...]) to replace
// the list (buffer-or-deliver: registered at module load).

import { getSs58AddressInfo } from 'polkadot-api'
import { deriveAddresses, devKeyAtIndex } from './derive'

export interface AccountSource {
  /** Calls cb with the current address list immediately, then again on
   *  every change. Returns an unsubscribe function. */
  subscribe(cb: (addresses: string[]) => void): () => void
}

const STORAGE_KEY = 'pkt_dev_addresses_v1'

let addresses: string[] = []
const listeners = new Set<(addresses: string[]) => void>()

/** Keep only valid, deduplicated SS58 addresses; drop the rest loudly. */
function sanitize(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const addr = raw.trim()
    if (!addr) continue
    let valid = false
    try { valid = getSs58AddressInfo(addr).isValid } catch { /* not SS58 */ }
    if (!valid) {
      console.warn('[chain] dropping invalid SS58 address', addr)
      continue
    }
    if (!out.includes(addr)) out.push(addr)
  }
  return out
}

function persist(list: string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch { /* storage unavailable */ }
}

function loadPersisted(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function set(list: unknown, opts: { persist: boolean; explicit?: boolean }): void {
  addresses = sanitize(list)
  if (opts.persist) persist(addresses)
  for (const cb of listeners) {
    try { cb(addresses) } catch { /* a listener throwing can't break the channel */ }
  }
}

// ---- Globals registered at module load ----------------------------------

;(window as unknown as Record<string, unknown>).setAccounts = (list: string[]) => {
  set(list, { persist: false })
}

;(function takeInitial(): void {
  try {
    const params = new URLSearchParams(window.location.search)
    // An explicit ?player=/?alias= (without ?address=) means "show me this
    // identity's shelf": a persisted address list from an earlier ?address=
    // session would shadow the identity's purse scan forever, so drop it.
    // Both are dev affordances — the current URL outranks old leftovers.
    if (!params.get('address') && (params.get('player') || params.get('alias'))) {
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    }
    // ?derive=1 forces the deriver and clears any stale persisted list
    // (a previous ?address= session would otherwise shadow it forever).
    if (params.get('derive') === '1') {
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
      window.setTimeout(() => {
        try {
          set(deriveAddresses(devKeyAtIndex()), { persist: false, explicit: false })
        } catch (err) {
          console.warn('[chain] account derivation failed', err)
        }
      }, 0)
      return
    }
    const param = params.get('address')
    if (param) {
      set(param.split(','), { persist: true })
      return
    }
    const initial = (window as unknown as Record<string, unknown>).__ACCOUNTS__
    if (Array.isArray(initial)) {
      set(initial, { persist: false })
      return
    }
    const persisted = loadPersisted()
    if (persisted.length > 0) {
      addresses = persisted
      return
    }
    // Nothing explicit: leave the list empty. The sync loop then
    // gap-scans the purse subtree of whichever dev root the player
    // identity picks (start.ts scanDerivedOwned) — the dev player when
    // nothing says otherwise.
  } catch { /* ignore */ }
})()

/** The address list as of right now — for consumers that need a synchronous
 *  read (e.g. scoping the collection cache) rather than a subscription. */
export function currentAddresses(): string[] {
  return addresses
}

export function getAccountSource(): AccountSource {
  return {
    subscribe(cb) {
      listeners.add(cb)
      try { cb(addresses) } catch { /* see set() */ }
      return () => { listeners.delete(cb) }
    }
  }
}
