// Chain -> gallery sync orchestrator: assembles the shelf from two chains
// (design doc §3.3).
//
//   People Chain  Game.NftClaimCredits  -> what the player EARNED
//   Asset Hub     Scarcity.NftsByOwner  -> what is MINTED, and where
//
// Every credit becomes one item. A credit whose hash matches a minted
// item's identity hash is that item, already Owned; the rest split by
// Asset Hub's nft-claims state (chain/pallets/claims.ts): root not arrived ->
// Earned, root present and leaf unclaimed -> Claimable (both render
// wrapped, `pending: true`; Claimable additionally carries
// `claimable: true` for Phase 2's actions), leaf claimed but the item
// at none of our purses -> minted by another device or the auto-claim,
// withheld from the shelf until the purse scan finds it. ASSUMPTION,
// verify with the minter-contract work: the minted item's "hash"
// metadata equals the credit hash (identity carried through the mint).
// Contained to mergeShelf() below.
//
// Results land in the SAME collection store the native push bridge feeds
// (bridge/collection.ts): cache-first render, boot resolution,
// generation/remount logic and flow events behave identically whichever
// source spoke.
//
// Deliberately silent when it has nothing trustworthy to say:
//   - no provider (embedded host without the chain seam) -> inert
//   - no addresses AND no identity -> no delivery (nobody has told us
//     where to look yet — leave the store to native)
//   - ?mock= session -> inert (mocks must never mix with chain data)

import { getAssetHubApi, getPeopleApi, destroyClients, type AssetHubApi } from './client'
import { fetchOwned, fetchOwnedAt } from './pallets/scarcity'
import { fetchCredits, type Credit } from './pallets/credits'
import { fetchClaimStates, type ClaimState } from './pallets/claims'
import { getAccountSource } from './accounts'
import { getIdentitySource, type PlayerIdentity } from './identity'
import { devPurseAddress, devRootPathOf } from './derive'
import { isEmbedded } from '../bridge/embed'
import { deliverCollection } from '../bridge/collection'
import { sendFlowEvent } from '../bridge/send'
import type { OwnedNft } from '../bridge/types'

// How often to re-read once healthy. Polling both chains together keeps
// the first cut simple (the design's "watch the credit map" refinement
// can replace the People Chain leg later).
const REFRESH_MS = 30_000
// A poll that outlives this is a wedged connection (e.g. the socket died
// during laptop sleep), not a slow one: without a deadline the await
// never settles and the sync silently freezes forever.
const POLL_TIMEOUT_MS = 30_000
// Reads past this many addresses are dropped (store itself caps items at
// 500; this bounds the per-poll query fan-out).
const MAX_ACCOUNTS = 100
// Error backoff: exponential between these bounds.
const BACKOFF_MIN_MS = 5_000
const BACKOFF_MAX_MS = 60_000

let running = false
let timer: number | undefined
let unsubscribers: (() => void)[] = []
// Bumped on every stop/input change so an in-flight fetch that resolves
// late can tell it's stale and drop its result.
let generation = 0

/** Owned items win over credits with the same hash; unminted credits
 *  render as wrapped (`pending`), Claimable ones flagged for Phase 2's
 *  actions; credits Asset Hub says are claimed elsewhere are withheld
 *  (offering a claim that can only fail AlreadyClaimed helps nobody).
 *  Store keys are normalized (lowercase, no 0x), so compare the same
 *  way. */
function mergeShelf(
  owned: OwnedNft[],
  credits: Credit[],
  claimStates: Map<string, ClaimState>
): OwnedNft[] {
  const mintedKeys = new Set(owned.map((o) => o.hash.replace(/^0x/i, '').toLowerCase()))
  const earned: OwnedNft[] = []
  for (const credit of credits) {
    const key = credit.hash.replace(/^0x/i, '').toLowerCase()
    if (mintedKeys.has(key)) continue
    const state = claimStates.get(credit.hash) ?? 'earned'
    if (state === 'claimed') {
      console.warn('[chain] a claimed credit is minted at none of our purses; withheld')
      continue
    }
    earned.push({
      hash: credit.hash,
      pending: true,
      ...(state === 'claimable' ? { claimable: true } : {}),
      ...(credit.awardedAt !== undefined ? { mintedAt: credit.awardedAt } : {})
    })
  }
  return [...owned, ...earned]
}

// ---- dev purse scan --------------------------------------------------------
// TEMPORARY SOLUTION TO OPEN QUESTION, DEPENDENCY #5 (see derive.ts):
// when no explicit purse list was injected, the player identity picks the
// dev root whose purse subtree gets scanned — gap-limit style, batches of
// SCAN_BATCH, stopping after a fully-empty batch. Occupied indexes are
// remembered in localStorage so purses past a gap (emptied by transfers)
// stay visible on later visits.

const SCAN_BATCH = 10
const SCAN_MAX = 1_000
const SCAN_CACHE_PREFIX = 'pkt_purse_scan_v1:'

function loadScanCache(rootPath: string): number[] {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_PREFIX + rootPath)
    const v = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n >= 0 && n < SCAN_MAX) : []
  } catch {
    return []
  }
}
function saveScanCache(rootPath: string, occupied: number[]): void {
  try { localStorage.setItem(SCAN_CACHE_PREFIX + rootPath, JSON.stringify(occupied)) } catch { /* ignore */ }
}

/** The owned items of a dev root's purse subtree. One batched read per
 *  SCAN_BATCH purses; a fully-empty batch ends the walk. Previously seen
 *  occupied indexes beyond the stop point are re-checked so a hole left
 *  by transfers cannot hide items behind it (on this device, at least —
 *  the real convention is dependency #5's to settle). */
async function scanDerivedOwned(assetHub: AssetHubApi, rootPath: string): Promise<OwnedNft[]> {
  const owned: OwnedNft[] = []
  const occupied: number[] = []
  let start = 0
  for (;;) {
    const indexes = Array.from({ length: SCAN_BATCH }, (_, k) => start + k)
    const reads = await fetchOwnedAt(assetHub, indexes.map((i) => devPurseAddress(rootPath, i)))
    reads.forEach((r, k) => {
      if (!r.occupied) return
      occupied.push(indexes[k])
      if (r.item) owned.push(r.item)
    })
    if (!reads.some((r) => r.occupied)) break
    start += SCAN_BATCH
    if (start >= SCAN_MAX) break
  }
  const lastScanned = start + SCAN_BATCH - 1
  const remembered = loadScanCache(rootPath).filter((i) => i > lastScanned)
  if (remembered.length > 0) {
    const reads = await fetchOwnedAt(assetHub, remembered.map((i) => devPurseAddress(rootPath, i)))
    reads.forEach((r, k) => {
      if (!r.occupied) return
      occupied.push(remembered[k])
      if (r.item) owned.push(r.item)
    })
  }
  saveScanCache(rootPath, occupied)
  return owned
}

/** Which dev root to scan for this session, or null when scanning is off
 *  (inside a host, or an explicit address list was injected). An identity
 *  that is a dev-held account picks its own subtree; anything else —
 *  no identity, an alias, an unknown address — falls back to the bare
 *  dev-player root, the default shelf. */
function derivedRootOf(identity: PlayerIdentity | null): string | null {
  if (isEmbedded) return null
  if (identity?.kind === 'account') return devRootPathOf(identity.address) ?? ''
  return ''
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`chain poll timed out after ${ms / 1000}s`)), ms)
    promise.then(
      (v) => { window.clearTimeout(t); resolve(v) },
      (e) => { window.clearTimeout(t); reject(e) }
    )
  })
}

export function startChainSync(): void {
  if (running) return
  if (new URLSearchParams(window.location.search).get('mock')) return
  if (!getAssetHubApi()) return
  running = true

  let addresses: string[] = []
  let identity: PlayerIdentity | null = null
  let backoff = BACKOFF_MIN_MS

  async function poll(): Promise<void> {
    const gen = generation
    // Resolved per poll: after a wedged connection is destroyed below,
    // the next poll builds fresh clients instead of reusing dead ones.
    const assetHub = getAssetHubApi()
    if (!assetHub) return
    // People Chain is optional: without it (or without an identity) the
    // shelf is owned-items-only, never an error.
    const people = getPeopleApi()
    try {
      const { owned, credits, claimStates } = await withDeadline(
        (async () => {
          // Explicit purse lists (native, ?address=) win; otherwise the
          // identity's dev root is gap-scanned for its purses.
          const derivedRoot = addresses.length === 0 ? derivedRootOf(identity) : null
          const [owned, credits] = await Promise.all([
            derivedRoot !== null
              ? scanDerivedOwned(assetHub, derivedRoot)
              : fetchOwned(assetHub, addresses),
            people && identity ? fetchCredits(people, identity) : Promise.resolve([])
          ])
          const claimStates = await fetchClaimStates(assetHub, credits)
          return { owned, credits, claimStates }
        })(),
        POLL_TIMEOUT_MS
      )
      if (!running || gen !== generation) return
      backoff = BACKOFF_MIN_MS
      deliverCollection({ owned: mergeShelf(owned, credits, claimStates) })
      timer = window.setTimeout(() => { void poll() }, REFRESH_MS)
    } catch (err) {
      if (!running || gen !== generation) return
      const detail = err instanceof Error ? err.message : String(err)
      console.warn('[chain] sync failed', err)
      sendFlowEvent({ type: 'flow.error', phase: 'chain', detail })
      // Assume the worst (a dead socket) and rebuild: destroying costs one
      // reconnect, while reusing a wedged client hangs every later poll.
      destroyClients()
      timer = window.setTimeout(() => { void poll() }, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  function restart(): void {
    generation++
    if (timer !== undefined) window.clearTimeout(timer)
    backoff = BACKOFF_MIN_MS
    // Outside a host the purse scan always has a root to walk (the dev
    // player by default), so dev sessions poll even with no inputs.
    if (addresses.length > 0 || identity || !isEmbedded) void poll()
  }

  unsubscribers = [
    getAccountSource().subscribe((next) => {
      if (next.length > MAX_ACCOUNTS) {
        console.warn(`[chain] address list exceeds ${MAX_ACCOUNTS}; extra addresses ignored`)
      }
      addresses = next.slice(0, MAX_ACCOUNTS)
      restart()
    }),
    getIdentitySource().subscribe((next) => {
      identity = next
      restart()
    })
  ]
}

/** Tear the sync down (dev panel loading a mock, tests). Safe to call
 *  when never started. */
export function stopChainSync(): void {
  if (!running) return
  running = false
  generation++
  if (timer !== undefined) window.clearTimeout(timer)
  for (const off of unsubscribers) off()
  unsubscribers = []
  destroyClients()
}
