// The dev inputs feeding the identity seam (identity.ts): the
// ?player=/?alias= QA override, dev-name expansion, and dev-session
// persistence. Everything here is a dev/QA affordance — production
// resolves identity from its real source (the container) every boot.

import { isEmbedded } from '../host/embed'
import { readJson, writeJson, removeKey } from '../lib/storage'
import { devAddressOf } from './derive'
import type { PlayerIdentity } from './identity'

// True when the session's identity came from an explicit URL param — a
// QA affordance that outranks the container's own resolution and lets
// the purse scan / connection layer relax their production rules.
let devOverride = false

/** Whether an explicit ?player=/?alias= override drives this session. */
export function hasDevOverride(): boolean {
  return devOverride
}

/** The ?player=/?alias= QA override, if present — honoured in EVERY mode
 *  (inside a host too). Reading a present override marks the session as
 *  override-driven. Returns raw input; the seam validates it. */
export function takeUrlIdentityOverride(): { account: string } | { alias: string } | null {
  try {
    const params = new URLSearchParams(window.location.search)
    const player = params.get('player')
    if (player) {
      devOverride = true
      return { account: player }
    }
    const alias = params.get('alias')
    if (alias) {
      devOverride = true
      return { alias }
    }
  } catch { /* ignore */ }
  return null
}

/** Dev names (bob, alice, …) expanded to their DEV_PHRASE addresses.
 *  Inside a host only an explicit override unlocks this; anything that
 *  isn't a known dev name returns null (real addresses pass through the
 *  seam untouched). */
export function devAccountExpansion(raw: string): string | null {
  if (isEmbedded && !devOverride) return null
  return devAddressOf(raw) ?? null
}

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

export function persistDevIdentity(id: PlayerIdentity | null): void {
  if (id) writeJson(STORAGE_KEY, id)
  else removeKey(STORAGE_KEY)
}

/** The identity a previous dev session persisted, unvalidated — the seam
 *  re-validates it through the same gate as fresh input. */
export function loadPersistedDevIdentity(): PlayerIdentity | null {
  return readJson<PlayerIdentity>(STORAGE_KEY)
}
