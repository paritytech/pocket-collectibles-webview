// Chain -> gallery sync orchestrator: assembles the shelf from two chains
// (design doc §3.3).
//
//   People Chain  Game.NftClaimCredits  -> what the player EARNED
//   Asset Hub     Scarcity.NftsByOwner  -> what is MINTED, and where
//
// Every credit becomes one item. A credit whose hash matches a minted
// item's identity hash is that item, already Owned; the rest are Earned
// and render wrapped (delivered as `pending: true` — the store/UI's
// existing earned-but-not-final state). ASSUMPTION, verify with the
// selector-contract work: the minted item's "hash" metadata equals the
// credit hash (identity carried through the mint). Contained to
// mergeShelf() below.
//
// Earned vs Claimable: the design splits unminted credits by whether
// their merkle root reached Asset Hub. Each credit now arrives with its
// People-Chain root (credits.ts, runtime APIs), but Asset Hub cannot
// receive roots yet (individuality feat/1253-tn-sync-merkle-roots-asset-hub
// unmerged), so today every unminted credit is Earned. When root sync
// lands, compare credit.root against Asset Hub's storage in mergeShelf().
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

import { getChainApi, destroyClients } from './client'
import { fetchOwned, type ScarcityApi } from './scarcity'
import { fetchCredits, type Credit, type PeopleApi } from './credits'
import { getAccountSource } from './accounts'
import { getIdentitySource, type PlayerIdentity } from './identity'
import { deliverCollection } from '../bridge/collection'
import { sendFlowEvent } from '../bridge/send'
import type { OwnedNft } from '../bridge/types'

// How often to re-read once healthy. Polling both chains together keeps
// the first cut simple (the design's "watch the credit map" refinement
// can replace the People Chain leg later).
const REFRESH_MS = 30_000
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
 *  render as wrapped/earned (`pending`). Store keys are normalized
 *  (lowercase, no 0x), so compare the same way. */
function mergeShelf(owned: OwnedNft[], credits: Credit[]): OwnedNft[] {
  const mintedKeys = new Set(owned.map((o) => o.hash.replace(/^0x/i, '').toLowerCase()))
  const earned: OwnedNft[] = []
  for (const credit of credits) {
    const key = credit.hash.replace(/^0x/i, '').toLowerCase()
    if (mintedKeys.has(key)) continue
    // credit.root is known once the People Chain computed it (a rootless
    // credit is seconds old); Claimable additionally needs that root ON
    // ASSET HUB — split here when the root-sync work lands (until then
    // everything unminted is Earned).
    earned.push({
      hash: credit.hash,
      pending: true,
      ...(credit.awardedAt !== undefined ? { mintedAt: credit.awardedAt } : {})
    })
  }
  return [...owned, ...earned]
}

export function startChainSync(): void {
  if (running) return
  if (new URLSearchParams(window.location.search).get('mock')) return
  const assetHub = getChainApi('assetHub') as ScarcityApi | null
  if (!assetHub) return
  // People Chain is optional: without it (or without an identity) the
  // shelf is owned-items-only, never an error.
  const people = getChainApi('people') as PeopleApi | null
  running = true

  let addresses: string[] = []
  let identity: PlayerIdentity | null = null
  let backoff = BACKOFF_MIN_MS

  async function poll(): Promise<void> {
    const gen = generation
    try {
      const [owned, credits] = await Promise.all([
        fetchOwned(assetHub!, addresses),
        people && identity ? fetchCredits(people, identity) : Promise.resolve([])
      ])
      if (!running || gen !== generation) return
      backoff = BACKOFF_MIN_MS
      deliverCollection({ owned: mergeShelf(owned, credits) })
      timer = window.setTimeout(() => { void poll() }, REFRESH_MS)
    } catch (err) {
      if (!running || gen !== generation) return
      const detail = err instanceof Error ? err.message : String(err)
      console.warn('[chain] sync failed', err)
      sendFlowEvent({ type: 'flow.error', phase: 'chain', detail })
      timer = window.setTimeout(() => { void poll() }, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  function restart(): void {
    generation++
    if (timer !== undefined) window.clearTimeout(timer)
    backoff = BACKOFF_MIN_MS
    if (addresses.length > 0 || identity) void poll()
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
