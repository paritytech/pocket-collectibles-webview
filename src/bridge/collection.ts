// Owned-collection channel.
//
// Native delivers the user's collectibles by any combination of:
//   1. window.__COLLECTION__ set before our JS runs (immediate read)
//   2. window.setCollection(input)  — replace the whole set (deferred push)
//   3. window.pushNft(item)         — upsert one item (incremental stream)
//
// All three feed a single Map keyed by normalized hash, so duplicate
// deliveries collapse (last write wins) exactly like the on-chain
// `Nfts` double-map's key uniqueness. Subscribers always receive the
// full current snapshot — they never have to merge deltas themselves.
//
// Same buffer-or-deliver discipline as the game-results bridge: globals
// are registered at module load so native can call them before React
// mounts without anything being dropped.

import type { CollectionInput, OwnedNft, Ticket, TicketState } from './types'
import { loadCachedCollection, saveCachedCollection } from './collectionCache'

/** Everything the channel knows, delivered as one snapshot: owned items
 *  plus (bridge v2) unminted tickets. v1 hosts never send tickets, so the
 *  array is simply always empty for them. */
export interface CollectionSnapshot {
  items: OwnedNft[]
  tickets: Ticket[]
}

type Listener = (snap: CollectionSnapshot) => void

// Hard cap on how many items we keep. Native is NOT trusted to send a sane
// count — without this a runaway/whale payload would build tens of thousands
// of DOM nodes + image loads and lock the WebView. Excess NEW items are
// dropped (and counted, see getDroppedCount); existing keys still update.
const MAX_OWNED = 500
// Tickets cap. A single game yields ~5–10 credits and they expire, so any
// realistic shelf is small; the cap only guards against a hostile payload.
const MAX_TICKETS = 50
// Plausible Unix-seconds range for a mint time. Anything outside (e.g. a
// millisecond value sent where seconds were expected, or garbage) is treated
// as unknown rather than rendered as a year-50000 date / "Invalid Date".
const TS_MIN = 1262304000 // 2010-01-01
const TS_MAX = 4102444800 // 2100-01-01

// Keyed by normalized hash (lowercase, no 0x). The value keeps the
// hash in its original normalized form plus the latest metadata.
const store = new Map<string, OwnedNft>()
// Unminted claim credits, keyed the same way. Replaced wholesale by
// setCollection; pushNft never touches tickets (it streams owned items).
const ticketStore = new Map<string, Ticket>()
const listeners = new Set<Listener>()
// Display name arrives alongside the collection; cached separately so a
// later pushNft doesn't clobber it.
let displayName: string | undefined
// True once native has delivered *anything* (setCollection / pushNft, or an
// initial __COLLECTION__). Lets the UI tell "empty collection" apart from
// "native hasn't spoken yet" — both present as a zero-length snapshot.
let delivered = false
// Bumped only when a *wholesale* setCollection changes the SET OF ITEMS
// (compared via signatureOf). The UI keys the gallery off this, so a new
// collection replays the entrance while a same-content refresh OR an
// incremental pushNft does not remount.
let generation = 0
let lastSignature = ''
// Items dropped by the MAX_OWNED cap in the most recent delivery (telemetry).
let droppedCount = 0

// Microtask shim for coalescing notifications.
const queueMicro: (cb: () => void) => void =
  typeof queueMicrotask === 'function' ? queueMicrotask : (cb) => { void Promise.resolve().then(cb) }

/** Normalize a hash to a stable dedup key: strip an optional 0x prefix
 *  and lowercase. Returns null for anything that isn't a non-empty
 *  string — the caller drops such items. We do NOT enforce 64-hex here
 *  (the resolver is lenient and falls back), but we do require *some*
 *  content so empty strings can't occupy a slot. */
function normalizeKey(hash: unknown): string | null {
  if (typeof hash !== 'string') return null
  let h = hash.trim()
  if (!h) return null
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2)
  return h.toLowerCase()
}

/** Coerce a possibly-mistyped flag to boolean. Accepts true / 1 / "1" /
 *  "true" — but NOT the string "false" (which is truthy and would flip the
 *  meaning). */
function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' ||
    (typeof v === 'string' && v.trim().toLowerCase() === 'true')
}

/** Coerce a mint time to a sane Unix-seconds integer, or undefined. Accepts a
 *  number or a numeric string; rejects NaN/Infinity and anything outside
 *  [TS_MIN, TS_MAX] (catches millisecond values and garbage). */
function coerceMintedAt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v)
    : NaN
  if (!Number.isFinite(n)) return undefined
  const sec = Math.floor(n)
  return sec >= TS_MIN && sec <= TS_MAX ? sec : undefined
}

/** Coerce an arbitrary object into a clean OwnedNft, or null if it has
 *  no usable hash. Defensive against partial / mistyped native payloads. */
function coerceItem(raw: unknown): { key: string; item: OwnedNft } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const key = normalizeKey(obj.hash)
  if (!key) return null
  const item: OwnedNft = { hash: key }
  const mintedAt = coerceMintedAt(obj.mintedAt)
  if (mintedAt !== undefined) item.mintedAt = mintedAt
  if (truthyFlag(obj.pending)) item.pending = true
  if (typeof obj.collectionId === 'string' && obj.collectionId) {
    item.collectionId = obj.collectionId
  }
  const blocked = obj.transferBlocked as Record<string, unknown> | undefined
  if (blocked && typeof blocked === 'object' && typeof blocked.reason === 'string' && blocked.reason) {
    item.transferBlocked = { reason: blocked.reason }
  }
  const game = obj.gameLink as Record<string, unknown> | undefined
  if (
    game && typeof game === 'object' &&
    typeof game.label === 'string' && game.label &&
    typeof game.url === 'string' && game.url
  ) {
    item.gameLink = { label: game.label, url: game.url }
  }
  return { key, item }
}

/** Coerce an arbitrary object into a clean Ticket, or null. State strings
 *  outside the whitelist default to 'mintable' rather than dropping the
 *  ticket — a newer native adding states must never hide credits from the
 *  user; showing them as mintable at worst yields a failed-mint message,
 *  never a silent loss. */
function coerceTicket(raw: unknown): { key: string; ticket: Ticket } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const key = normalizeKey(obj.hash)
  if (!key) return null
  const state: TicketState = obj.state === 'finalizing' ? 'finalizing' : 'mintable'
  const ticket: Ticket = { hash: key, state }
  // Reuses the mint-time sanity window: an expiry is a Unix-seconds value in
  // the same plausible range, and garbage should read as "unknown", not 1970.
  const expiresAt = coerceMintedAt(obj.expiresAt)
  if (expiresAt !== undefined) ticket.expiresAt = expiresAt
  return { key, ticket }
}

function notify(): void {
  const snapshot = snapshot_()
  // Piggyback the last-known-good cache write on the coalesced notify, so a
  // pushNft burst costs one localStorage write, not one per item. Only after
  // a real native delivery — never write the cache-seeded data back to itself.
  // Tickets are deliberately NOT cached: a stale expiry / stale state is
  // worse than a blank shelf, and native re-delivers tickets on every boot.
  if (delivered) saveCachedCollection(snapshot.items, displayName)
  for (const cb of listeners) {
    try { cb(snapshot) } catch { /* a listener throwing can't break the channel */ }
  }
}

// Coalesce notifications: native streaming the set item-by-item via pushNft
// would otherwise fire one full snapshot + React render PER item (O(n^2)).
// Batch a burst into a single microtask-deferred notify.
let notifyScheduled = false
function scheduleNotify(): void {
  if (notifyScheduled) return
  notifyScheduled = true
  queueMicro(() => { notifyScheduled = false; notify() })
}

/** Stable signature of the current key set, so setCollection can tell a real
 *  change from a same-content refresh (and only then remount the gallery).
 *  OWNED-ONLY on purpose: a tickets-only redelivery (a finalizing→mintable
 *  flip, an expiry tick) re-notifies subscribers but must NOT bump the
 *  generation — the gallery would remount and replay its entrance over a
 *  change the user perceives as a chip flipping. A post-mint delivery
 *  changes the owned keys, bumps the generation, and the entrance replay IS
 *  the landing beat of the ceremony. */
function signatureOf(): string {
  return Array.from(store.keys()).sort().join(',')
}

/** Current owned + ticket sets as fresh arrays. Order is insertion order;
 *  the UI applies its own sort, so we don't sort here. */
function snapshot_(): CollectionSnapshot {
  return { items: Array.from(store.values()), tickets: Array.from(ticketStore.values()) }
}

/** Replace the whole store from a payload. Returns false (and changes
 *  nothing) for a non-object payload, so callers don't notify/remount on
 *  garbage. */
function ingestCollection(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  delivered = true
  const obj = input as Record<string, unknown>
  const owned = Array.isArray(obj.owned) ? obj.owned : []
  store.clear()
  droppedCount = 0
  for (const raw of owned) {
    const coerced = coerceItem(raw)
    if (!coerced) continue
    // Keep updating existing keys, but stop adding NEW ones past the cap.
    if (!store.has(coerced.key) && store.size >= MAX_OWNED) { droppedCount++; continue }
    store.set(coerced.key, coerced.item)
  }
  if (droppedCount > 0) {
    console.warn(`[collection] owned set exceeded ${MAX_OWNED}; dropped ${droppedCount} item(s)`)
  }
  // Tickets (bridge v2, optional). Wholesale replace, like `owned`: a
  // delivery without the field clears the shelf — native always sends the
  // complete current set, never a delta.
  ticketStore.clear()
  if (Array.isArray(obj.tickets)) {
    for (const raw of obj.tickets) {
      const coerced = coerceTicket(raw)
      if (!coerced) continue
      if (!ticketStore.has(coerced.key) && ticketStore.size >= MAX_TICKETS) continue
      ticketStore.set(coerced.key, coerced.ticket)
    }
  }
  if (typeof obj.displayName === 'string') {
    displayName = sanitizeDisplayName(obj.displayName)
  }
  return true
}

/** Sanitize a display name: strip HTML-sensitive chars (belt-and-braces;
 *  React escapes anyway) then truncate grapheme-safely so a 24th-char emoji
 *  isn't split mid-surrogate. Returns undefined for an empty result. */
function sanitizeDisplayName(v: string): string | undefined {
  const cleaned = v.trim().replace(/[<>"'&]/g, '')
  return Array.from(cleaned).slice(0, 24).join('') || undefined
}

// ---- Globals registered at module load ----------------------------------

;(window as unknown as Record<string, unknown>).setCollection = (input: CollectionInput) => {
  if (!ingestCollection(input)) return
  const sig = signatureOf()
  if (sig !== lastSignature) { lastSignature = sig; generation++ }
  scheduleNotify()
}

;(window as unknown as Record<string, unknown>).pushNft = (raw: unknown) => {
  const coerced = coerceItem(raw)
  if (!coerced) return
  // Incremental: never bumps generation. Honour the same cap as setCollection.
  if (!store.has(coerced.key) && store.size >= MAX_OWNED) {
    droppedCount++
    console.warn(`[collection] pushNft past ${MAX_OWNED}-item cap; ignored`)
    return
  }
  delivered = true
  store.set(coerced.key, coerced.item)
  scheduleNotify()
}

// Read an initial collection set synchronously on window before our JS ran.
;(function takeInitial(): void {
  try {
    const raw = (window as unknown as Record<string, unknown>).__COLLECTION__
    if (raw && typeof raw === 'object' && ingestCollection(raw)) {
      lastSignature = signatureOf()
    }
  } catch { /* ignore */ }
})()

// No native data yet (no __COLLECTION__): seed from the cached last-known
// collection so an offline / slow boot renders the user's collection instead
// of a spinner and then the empty state. Deliberately does NOT set
// `delivered` — the boot is still waiting on native. A live setCollection
// replaces this wholesale; seeding lastSignature means a same-content
// delivery won't bump the generation (no pointless gallery remount). A
// pushNft stream merges on top, which is safe because the owned set only
// ever grows (mints are neither transferable nor burnable).
;(function seedFromCache(): void {
  if (delivered) return
  const cached = loadCachedCollection()
  if (!cached) return
  for (const raw of cached.owned) {
    const coerced = coerceItem(raw)
    if (!coerced) continue
    if (!store.has(coerced.key) && store.size >= MAX_OWNED) continue
    store.set(coerced.key, coerced.item)
  }
  if (typeof cached.displayName === 'string') {
    displayName = sanitizeDisplayName(cached.displayName)
  }
  lastSignature = signatureOf()
})()

/** Snapshot of the collection captured at module load (before React
 *  mounts). Used to seed initial state so the first render isn't empty
 *  when native set the global early. */
export function readInitialCollection(): CollectionSnapshot & { displayName?: string } {
  return {
    ...snapshot_(),
    ...(displayName ? { displayName } : {})
  }
}

/** Subscribe to collection changes. Invoked immediately with the current
 *  snapshot, then again on every setCollection / pushNft. Returns an
 *  unsubscribe function. */
export function subscribeCollection(cb: Listener): () => void {
  listeners.add(cb)
  try { cb(snapshot_()) } catch { /* see notify() */ }
  return () => { listeners.delete(cb) }
}

/** Current display name, if native sent one. */
export function getDisplayName(): string | undefined {
  return displayName
}

/** True once native has delivered any collection data. Distinguishes a
 *  genuinely-empty collection from a not-yet-loaded one. */
export function hasDelivered(): boolean {
  return delivered
}

/** Number of wholesale collection replacements (setCollection) so far.
 *  The UI uses this as a remount key so a fresh collection replays the
 *  gallery entrance; incremental pushNft deliveries don't change it. */
export function getCollectionGeneration(): number {
  return generation
}

/** Number of items dropped by the MAX_OWNED cap in the most recent delivery.
 *  Lets the app surface telemetry when native sends more than we'll render. */
export function getDroppedCount(): number {
  return droppedCount
}

/** Clear all state + subscribers. Used by the dev panel when loading a
 *  fresh mock so old items don't bleed into the new scenario. Not called
 *  in production. */
export function resetCollection(): void {
  store.clear()
  ticketStore.clear()
  listeners.clear()
  displayName = undefined
  delivered = false
  generation = 0
  lastSignature = ''
  droppedCount = 0
}
