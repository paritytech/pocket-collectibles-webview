// Which purse addresses to read.
//
/*
* TEMPORARY SOLUTION TO OPEN QUESTION
* DEPENDENCY #5/#6
* https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
*
* Which accounts collectibles land at, and what host call returns the
* list a product may see. Until then this module is an injectable seam
* (__ACCOUNTS__ / setAccounts below) with the identity-driven purse scan
* as the fallback.
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
//   1. window.__ACCOUNTS__ set before our JS ran — the future production
//      seam, same discipline as __COLLECTION__
//   2. nothing — the sync loop (start.ts) then gap-scans the purse
//      subtree of the dev root the player identity maps to (?player=
//      names/addresses cover the dev/QA need; an explicit list always
//      wins over the scan).
// At any later point native may call window.setAccounts([...]) to replace
// the list (buffer-or-deliver: registered at module load).
// (A ?address= query param + localStorage persistence existed here until
// 2026-08-12; removed — unused for testing, and its persisted leftovers
// silently shadowed the ?player= purse scan across sessions.)

import { createObservable } from '../lib/observable'
import { isValidSs58 } from './ss58'

export interface AccountSource {
  /** Calls cb with the current address list immediately, then again on
   *  every change. Returns an unsubscribe function. */
  subscribe(cb: (addresses: string[]) => void): () => void
}

const addresses = createObservable<string[]>([])

/** Keep only valid, deduplicated SS58 addresses; drop the rest loudly. */
function sanitize(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const addr = raw.trim()
    if (!addr) continue
    if (!isValidSs58(addr)) {
      console.warn('[chain] dropping invalid SS58 address', addr)
      continue
    }
    if (!out.includes(addr)) out.push(addr)
  }
  return out
}

function set(list: unknown): void {
  addresses.set(sanitize(list))
}

// ---- Globals registered at module load ----------------------------------

;(window as unknown as Record<string, unknown>).setAccounts = (list: string[]) => {
  set(list)
}

;(function takeInitial(): void {
  try {
    const initial = (window as unknown as Record<string, unknown>).__ACCOUNTS__
    if (Array.isArray(initial)) {
      set(initial)
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
  return addresses.get()
}

export function getAccountSource(): AccountSource {
  return { subscribe: addresses.subscribe }
}
