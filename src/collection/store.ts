// Owned-collection store, fed by the chain sync (src/chain/start.ts) —
// the only live data source. Deliveries feed a single Map keyed by
// normalized hash, so duplicate items collapse (last write wins) exactly
// like the on-chain `Nfts` double-map's key uniqueness. Subscribers
// always receive the full current snapshot — they never have to merge
// deltas themselves.
//
// The coercion layer stays defensive even though the inputs are
// in-process: the cache seed re-ingests whatever an old build persisted,
// and dev mocks are hand-written.

import type { CollectionInput, OwnedNft } from './types'
import { normalizeHash } from '../lib/hash'
import { loadCachedCollection, saveCachedCollection, shelfScope } from './cache'
import { getIdentitySource } from '../chain/identity'

type Listener = (items: OwnedNft[]) => void

// Hard cap on how many items we keep. No input is trusted to have a sane
// count (a whale account is one big NftsByOwner read away) — without this a
// runaway payload would build tens of thousands of DOM nodes + image loads
// and lock the WebView. Excess NEW items are dropped (and counted, see
// getDroppedCount); existing keys still update.
const MAX_OWNED = 500
// Plausible Unix-seconds range for a mint time. Anything outside (e.g. a
// millisecond value sent where seconds were expected, or garbage) is treated
// as unknown rather than rendered as a year-50000 date / "Invalid Date".
const TS_MIN = 1262304000 // 2010-01-01
const TS_MAX = 4102444800 // 2100-01-01

// Keyed by normalized hash (lowercase, no 0x). The value keeps the
// hash in its original normalized form plus the latest metadata.
const store = new Map<string, OwnedNft>()
const listeners = new Set<Listener>()
// Display name arrives alongside the collection; cached separately so a
// later pushNft doesn't clobber it.
let displayName: string | undefined
// True once the chain sync has delivered *anything*. Lets the UI tell
// "empty collection" apart from "no poll has landed yet" — both present
// as a zero-length snapshot.
let delivered = false
// Bumped only when a delivery changes the SET OF ITEMS (compared via
// keySetOf). The UI keys the gallery off this, so a new collection
// replays the entrance while a same-content refresh does not remount.
let generation = 0
let lastKeySet = ''
// Full-content signature of the last notified snapshot: a delivery that
// changes nothing (the chain sync's 30s re-poll) is dropped before it
// costs a notify, a React render, and a localStorage write.
let lastContentSig = ''
// Whose shelf the store's content belongs to — shelfScope() captured at
// the moment of delivery. The cache write runs in a deferred microtask,
// by which time the identity seams may already describe another player;
// saving must use this captured value, never a fresh read.
let deliveredScope: string | null = null
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
  const h = normalizeHash(hash)
  return h || null
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

/** Coerce a value to a non-negative integer (a block number), or undefined.
 *  Accepts a number or numeric string; rejects NaN/Infinity/negatives/floats. */
function coerceBlockNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v)
    : NaN
  return Number.isInteger(n) && n >= 0 ? n : undefined
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
  if (truthyFlag(obj.claimable)) item.claimable = true
  const awardBlock = coerceBlockNumber(obj.awardBlock)
  if (awardBlock !== undefined) item.awardBlock = awardBlock
  // On-chain display metadata from the chain-read path. Item names get
  // their own, longer limit — sanitizeDisplayName's 24 graphemes were
  // sized for a player name and truncated real item names ("Sword &
  // Board of the Ancients"). The image URL must be http(s) (never
  // javascript: etc).
  if (typeof obj.name === 'string') {
    const name = sanitizeItemName(obj.name)
    if (name) item.name = name
  }
  if (typeof obj.imageUrl === 'string' && /^https?:\/\//i.test(obj.imageUrl.trim())) {
    item.imageUrl = obj.imageUrl.trim()
  }
  return { key, item }
}

function notify(): void {
  const snapshot = snapshotItems()
  // Piggyback the last-known-good cache write on the coalesced notify.
  // Only after a real delivery — never write the cache-seeded data back to
  // itself — and always under the scope captured when that delivery arrived.
  if (delivered && deliveredScope !== null) {
    saveCachedCollection(snapshot, deliveredScope, displayName)
  }
  for (const cb of listeners) {
    try { cb(snapshot) } catch { /* a listener throwing can't break the channel */ }
  }
}

// Coalesce notifications: a burst of deliveries in one tick costs a single
// microtask-deferred notify instead of one snapshot + React render each.
let notifyScheduled = false
function scheduleNotify(): void {
  if (notifyScheduled) return
  notifyScheduled = true
  queueMicro(() => { notifyScheduled = false; notify() })
}

/** Stable signature of the current CONTENT (keys + display fields), so
 *  setCollection can tell a real change from a same-content refresh. Two
 *  uses, one string: an unchanged signature skips notify/save entirely
 *  (the chain re-polls every 30s — identical data must cost nothing), and
 *  only a changed KEY SET remounts the gallery (metadata edits re-render
 *  in place; see deliverCollection). */
function signatureOf(): string {
  return Array.from(store.values())
    .map((o) => [o.hash, o.name ?? '', o.imageUrl ?? '', o.pending ? 'p' : '', o.claimable ? 'c' : '', o.mintedAt ?? '', o.awardBlock ?? ''].join('~'))
    .sort()
    .join(',') + `|${displayName ?? ''}`
}

/** The key set alone — drives the generation bump (gallery remount). */
function keySetOf(): string {
  return Array.from(store.keys()).sort().join(',')
}

/** Current owned set as a fresh array. Order is insertion order; the UI
 *  applies its own sort, so we don't sort here. */
function snapshotItems(): OwnedNft[] {
  return Array.from(store.values())
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

/** Item names come from chain metadata (values bounded at 256 bytes by the
 *  runtime) and legitimately contain & and ' — only strip the HTML-bracket
 *  chars and cap at a display-sane 64 graphemes. */
function sanitizeItemName(v: string): string | undefined {
  const cleaned = v.trim().replace(/[<>"]/g, '')
  return Array.from(cleaned).slice(0, 64).join('') || undefined
}

/** Wholesale collection delivery — the single ingest point, fed by the
 *  chain sync (src/chain/start.ts) and dev mocks (App.tsx).
 *  Bumps the generation only when the item SET changed (so a same-content
 *  refresh never remounts the gallery), and skips the notify/save
 *  entirely when nothing at all changed — except for the very first
 *  delivery, which must always notify so the UI can leave its boot state
 *  (App reads hasDelivered() inside the subscription callback). */
export function deliverCollection(input: CollectionInput): void {
  const wasDelivered = delivered
  if (!ingestCollection(input)) return
  deliveredScope = shelfScope()
  const keys = keySetOf()
  if (keys !== lastKeySet) { lastKeySet = keys; generation++ }
  const sig = signatureOf()
  if (sig === lastContentSig && wasDelivered) return
  lastContentSig = sig
  scheduleNotify()
}

// No chain data yet: seed from the cached last-known collection so an
// offline / slow boot renders the user's collection instead of a spinner
// and then the empty state. Deliberately does NOT set `delivered` — the
// boot is still waiting on the first poll. A live delivery replaces this
// wholesale; seeding lastKeySet means a same-content delivery won't bump
// the generation (no pointless gallery remount) — though the FIRST
// delivery always notifies, so hasDelivered() reaches the UI even when
// its content matches the seed.
//
// The cache is scope-keyed, and the scope input (the identity) may
// legitimately arrive AFTER module load — in a container it resolves
// asynchronously from the host — so a failed seed stays armed and retries
// when the identity delivers, until something seeds or real data arrives.
function trySeedFromCache(): boolean {
  if (delivered || store.size > 0) return true
  const cached = loadCachedCollection()
  if (!cached) return false
  for (const raw of cached.owned) {
    const coerced = coerceItem(raw)
    if (!coerced) continue
    if (!store.has(coerced.key) && store.size >= MAX_OWNED) continue
    store.set(coerced.key, coerced.item)
  }
  if (typeof cached.displayName === 'string') {
    displayName = sanitizeDisplayName(cached.displayName)
  }
  lastKeySet = keySetOf()
  // A late seed lands after React subscribed — push it out. (At module
  // load this fans out to zero listeners; `delivered` is still false so
  // nothing is written back to the cache.)
  scheduleNotify()
  return true
}

;(function seedFromCacheWithRetry(): void {
  if (trySeedFromCache()) return
  const disarm: Array<() => void> = []
  const retry = (): void => {
    if (trySeedFromCache()) {
      for (const off of disarm) off()
      disarm.length = 0
    }
  }
  disarm.push(getIdentitySource().subscribe(retry))
})()

/** Snapshot of the collection captured at module load (before React
 *  mounts). Used to seed initial state so the first render isn't empty
 *  when the cache seed already populated the store. */
export function readInitialCollection(): { items: OwnedNft[]; displayName?: string } {
  return {
    items: snapshotItems(),
    ...(displayName ? { displayName } : {})
  }
}

/** Subscribe to collection changes. Invoked immediately with the current
 *  snapshot, then again on every delivery. Returns an unsubscribe
 *  function. */
export function subscribeCollection(cb: Listener): () => void {
  listeners.add(cb)
  try { cb(snapshotItems()) } catch { /* see notify() */ }
  return () => { listeners.delete(cb) }
}

/** Current display name, if a delivery carried one. */
export function getDisplayName(): string | undefined {
  return displayName
}

/** True once any collection data has been delivered. Distinguishes a
 *  genuinely-empty collection from a not-yet-loaded one. */
export function hasDelivered(): boolean {
  return delivered
}

/** Bumped when a delivery changes the item set. The UI uses this as a
 *  remount key so a fresh collection replays the gallery entrance. */
export function getCollectionGeneration(): number {
  return generation
}

/** Number of items dropped by the MAX_OWNED cap in the most recent delivery.
 *  Lets the app surface telemetry when a shelf holds more than we render. */
export function getDroppedCount(): number {
  return droppedCount
}

/** Clear all state + subscribers. Used by the dev panel when loading a
 *  fresh mock so old items don't bleed into the new scenario. Not called
 *  in production. */
export function resetCollection(): void {
  store.clear()
  listeners.clear()
  displayName = undefined
  delivered = false
  generation = 0
  lastKeySet = ''
  lastContentSig = ''
  deliveredScope = null
  droppedCount = 0
}
