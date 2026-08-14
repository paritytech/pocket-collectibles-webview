/* Who the player is, for the credit map.
 *
 * This module is the permanent home of an OPEN QUESTION, DEPENDENCY #2/#3
 * (DEPENDENCIES.md): which identity the player queries (and claims) as —
 * game-subtree account or person alias — and where production learns it.
 *
 *   PERMANENT — the PlayerIdentity type (mirrors the pallet's
 *   `AccountOrPerson`, chain reality), the validation gate, and the
 *   IdentitySource subscription every consumer reads through.
 *   CONTAINER — inside a product-sdk host the player IS the product
 *   account at derivation index 0 (host-derived, shared with the purse
 *   scan via purses.ts). Whether the award pipeline credits this account
 *   or a person ALIAS instead is still open (dependency #2/#3) — if it is
 *   the alias, this branch swaps to getProductAccountAlias.
 *   TEMPORARY — the dev inputs feeding the seam (devIdentity.ts: the
 *   ?player=/?alias= QA override, dev-name expansion, persistence).
 *
 * The credit map is keyed by the pallet's `AccountOrPerson`: an
 * ordinary account, or an alias (32-byte person id) for players known
 * through proof-of-personhood.
 *
 * Resolution, via initIdentity() at boot:
 *   1. ?player=<ss58 | dev name (bob, …)> or ?alias=<0x+64hex> — an
 *      explicit QA override, honoured in EVERY mode (inside a host too).
 *   2. container — product account 0.
 *   3. dev — the identity a previous session persisted.
*/

import { isInContainer } from '../host/embed'
import { createObservable } from '../lib/observable'
import { withDeadline } from '../lib/deadline'
import { isValidSs58 } from './ss58'
import { hostPurseSource } from './purses'
import {
  takeUrlIdentityOverride,
  devAccountExpansion,
  persistDevIdentity,
  loadPersistedDevIdentity
} from './devIdentity'

export type PlayerIdentity =
  | { kind: 'account'; address: string }
  | { kind: 'alias'; alias: string } // 0x-prefixed 32-byte hex

const identity = createObservable<PlayerIdentity | null>(null)

function parseIdentity(raw: unknown): PlayerIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.account === 'string') {
    const address = devAccountExpansion(o.account) || o.account.trim()
    if (isValidSs58(address)) return { kind: 'account', address }
    console.warn('[chain] dropping invalid player account (need SS58 or a dev name)', address)
    return null
  }
  if (typeof o.alias === 'string') {
    const alias = o.alias.trim().toLowerCase()
    if (/^0x[0-9a-f]{64}$/.test(alias)) return { kind: 'alias', alias }
    console.warn('[chain] dropping invalid player alias (need 0x + 64 hex)', o.alias)
    return null
  }
  return null
}

function loadPersisted(): PlayerIdentity | null {
  const o = loadPersistedDevIdentity()
  if (!o) return null
  // Re-validate through the same gate as fresh input.
  return o.kind === 'account'
    ? parseIdentity({ account: o.address })
    : parseIdentity({ alias: o.alias })
}

function set(raw: unknown, opts: { persist: boolean }): void {
  const next = parseIdentity(raw)
  if (opts.persist) persistDevIdentity(next)
  identity.set(next)
}

// ---- Resolution, called once from the boot sequence ----------------------

/** Resolve who the player is. URL params win everywhere (QA override,
 *  works inside a host too). Otherwise a container asks the host for
 *  product account 0 (also purse 0 — same memoized source the scan
 *  uses); on failure the identity stays null and the boot-timeout path
 *  reports it. Dev falls back to the last persisted identity. Never
 *  rejects. */
export async function initIdentity(): Promise<void> {
  const override = takeUrlIdentityOverride()
  if (override) {
    set(override, { persist: !isInContainer })
    return
  }
  if (isInContainer) {
    try {
      const source = await withDeadline(hostPurseSource(), 10_000, 'host identity')
      if (source) {
        const address = await withDeadline(source.addressAt(0), 10_000, 'host identity')
        set({ account: address }, { persist: false })
        return
      }
      // No product account for this DotNS id (a placeholder, dependency #1)
      // or a host that doesn't serve it — fall through to the dev resolution,
      // the TEMPORARY stand-in. Shipping hosts (iOS, desktop) DO implement
      // product accounts; this is gated on registering the real id.
    } catch (err) {
      console.warn('[chain] host identity resolution failed', err)
      return
    }
  }
  try {
    identity.set(loadPersisted())
  } catch { /* ignore */ }
}

/** The identity as of right now — for consumers that need a synchronous
 *  read (e.g. scoping the collection cache) rather than a subscription. */
export function currentIdentity(): PlayerIdentity | null {
  return identity.get()
}

export interface IdentitySource {
  /** Calls cb with the current identity (or null) immediately, then again
   *  on every change. Returns an unsubscribe function. */
  subscribe(cb: (identity: PlayerIdentity | null) => void): () => void
}

export function getIdentitySource(): IdentitySource {
  return { subscribe: identity.subscribe }
}
