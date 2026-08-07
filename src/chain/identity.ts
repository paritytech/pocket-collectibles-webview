// Who the player is, for the credit map.
//
// `Game.NftClaimCredits` is keyed by the pallet's `AccountOrPerson`: an
// ordinary account, or an alias (32-byte person id) for players known
// through proof-of-personhood. WHICH identity this player queries as, and
// where it comes from in production, is an open platform question
// (DEPENDENCIES.md #2/#3) — this module isolates it the same way
// accounts.ts isolates the purse-address convention.
//
// Resolution order at load:
//   1. ?player=<ss58>   or   ?alias=<0x + 64 hex>   — dev/QA; persisted
//   2. window.__PLAYER__ = { account } | { alias } set before our JS ran
//   3. the identity persisted by a previous session
// At any later point native may call window.setPlayerIdentity({...})
// (buffer-or-deliver: registered at module load). Pass null to clear.

import { getSs58AddressInfo } from 'polkadot-api'

export type PlayerIdentity =
  | { kind: 'account'; address: string }
  | { kind: 'alias'; alias: string } // 0x-prefixed 32-byte hex

const STORAGE_KEY = 'pkt_dev_player_v1'

let identity: PlayerIdentity | null = null
const listeners = new Set<(identity: PlayerIdentity | null) => void>()

function parseIdentity(raw: unknown): PlayerIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.account === 'string') {
    const address = o.account.trim()
    let valid = false
    try { valid = getSs58AddressInfo(address).isValid } catch { /* not SS58 */ }
    if (valid) return { kind: 'account', address }
    console.warn('[chain] dropping invalid player account', address)
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
  try {
    if (id) localStorage.setItem(STORAGE_KEY, JSON.stringify(id))
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage unavailable */ }
}

function loadPersisted(): PlayerIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as PlayerIdentity
    // Re-validate through the same gate as fresh input.
    return o.kind === 'account'
      ? parseIdentity({ account: o.address })
      : parseIdentity({ alias: o.alias })
  } catch {
    return null
  }
}

function set(raw: unknown, opts: { persist: boolean }): void {
  identity = parseIdentity(raw)
  if (opts.persist) persist(identity)
  for (const cb of listeners) {
    try { cb(identity) } catch { /* a listener throwing can't break the channel */ }
  }
}

// ---- Globals registered at module load ----------------------------------

;(window as unknown as Record<string, unknown>).setPlayerIdentity = (raw: unknown) => {
  set(raw, { persist: false })
}

;(function takeInitial(): void {
  try {
    const params = new URLSearchParams(window.location.search)
    const player = params.get('player')
    if (player) {
      set({ account: player }, { persist: true })
      return
    }
    const alias = params.get('alias')
    if (alias) {
      set({ alias }, { persist: true })
      return
    }
    const initial = (window as unknown as Record<string, unknown>).__PLAYER__
    if (initial) {
      set(initial, { persist: false })
      return
    }
    identity = loadPersisted()
  } catch { /* ignore */ }
})()

export interface IdentitySource {
  /** Calls cb with the current identity (or null) immediately, then again
   *  on every change. Returns an unsubscribe function. */
  subscribe(cb: (identity: PlayerIdentity | null) => void): () => void
}

export function getIdentitySource(): IdentitySource {
  return {
    subscribe(cb) {
      listeners.add(cb)
      try { cb(identity) } catch { /* see set() */ }
      return () => { listeners.delete(cb) }
    }
  }
}
