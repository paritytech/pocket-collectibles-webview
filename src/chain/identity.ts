/* Who the player is, for the credit map.
 *
 * This module is the permanent home of an OPEN QUESTION, DEPENDENCY #2/#3
 * (DEPENDENCIES.md): which identity the player queries (and claims) as —
 * game-subtree account or person alias — and where production learns it.
 * The module's PARTS age differently; each temporary piece is marked
 * inline:
 *
 *   PERMANENT — the PlayerIdentity type (mirrors the pallet's
 *   `AccountOrPerson`, chain reality), the validation gate, and the
 *   IdentitySource subscription every consumer reads through.
 *   CONTAINER — inside a product-sdk host the player IS the product
 *   account at derivation index 0 (host-derived, shared with the purse
 *   scan via purses.ts). Whether the award pipeline credits this account
 *   or a person ALIAS instead is still open (dependency #2/#3) — if it is
 *   the alias, this branch swaps to getProductAccountAlias.
 *   TEMPORARY — the dev inputs feeding the seam outside a container
 *   (see markers).
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

import { isEmbedded, isInContainer } from '../host/embed'
import { createObservable } from '../lib/observable'
import { readJson, writeJson, removeKey } from '../lib/storage'
import { withDeadline } from '../lib/deadline'
import { isValidSs58 } from './ss58'
import { devAddressOf } from './derive'
import { hostPurseSource } from './purses'

export type PlayerIdentity =
  | { kind: 'account'; address: string }
  | { kind: 'alias'; alias: string } // 0x-prefixed 32-byte hex

/*
* TEMPORARY SOLUTION TO OPEN QUESTION
* DEPENDENCY #2/#3
* https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
*
* Dev-session persistence, so a reload keeps showing the same shelf.
* Production resolves identity from its real source every boot instead.
*
*/
const STORAGE_KEY = 'pkt_dev_player_v1'

const identity = createObservable<PlayerIdentity | null>(null)

function parseIdentity(raw: unknown): PlayerIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.account === 'string') {
    // Dev names (bob, alice, …) expand to their DEV_PHRASE addresses.
    // Inside a host only an explicit ?player= override unlocks this;
    // real addresses pass through untouched.
    const address = ((!isEmbedded || devOverride) && devAddressOf(o.account)) || o.account.trim()
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

function persist(id: PlayerIdentity | null): void {
  if (id) writeJson(STORAGE_KEY, id)
  else removeKey(STORAGE_KEY)
}

function loadPersisted(): PlayerIdentity | null {
  const o = readJson<PlayerIdentity>(STORAGE_KEY)
  if (!o) return null
  // Re-validate through the same gate as fresh input.
  return o.kind === 'account'
    ? parseIdentity({ account: o.address })
    : parseIdentity({ alias: o.alias })
}

function set(raw: unknown, opts: { persist: boolean }): void {
  const next = parseIdentity(raw)
  if (opts.persist) persist(next)
  identity.set(next)
}

// ---- Resolution, called once from the boot sequence ----------------------

// True when the session's identity came from an explicit URL param — a
// QA affordance that outranks the container's own resolution and lets
// the purse scan / connection layer relax their production rules.
let devOverride = false

/** Whether an explicit ?player=/?alias= override drives this session. */
export function hasDevOverride(): boolean {
  return devOverride
}

/** Resolve who the player is. URL params win everywhere (QA override,
 *  works inside a host too). Otherwise a container asks the host for
 *  product account 0 (also purse 0 — same memoized source the scan
 *  uses); on failure the identity stays null and the boot-timeout path
 *  reports it. Dev falls back to the last persisted identity. Never
 *  rejects. */
export async function initIdentity(): Promise<void> {
  try {
    /*
    * TEMPORARY SOLUTION TO OPEN QUESTION
    * DEPENDENCY #2/#3
    * https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
    *
    * QA sessions inject an identity from outside. Whether the container
    * answer below (product account 0) is also what the award pipeline
    * credits — or a person alias is — decides how these age.
    *
    */
    const params = new URLSearchParams(window.location.search)
    const player = params.get('player')
    if (player) {
      devOverride = true
      set({ account: player }, { persist: !isInContainer })
      return
    }
    const alias = params.get('alias')
    if (alias) {
      devOverride = true
      set({ alias }, { persist: !isInContainer })
      return
    }
  } catch { /* ignore */ }
  if (isInContainer) {
    try {
      const source = await withDeadline(hostPurseSource(), 10_000, 'host identity')
      if (source) {
        const address = await withDeadline(source.addressAt(0), 10_000, 'host identity')
        set({ account: address }, { persist: false })
        return
      }
      // No product-account capability in this host (today's hosts) — fall
      // through to the dev resolution, the TEMPORARY stand-in.
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
