// Chain -> gallery sync orchestrator: assembles the shelf from two chains
// (design doc §3.3).
//
//   People Chain  Game.NftClaimCredits  -> what the player EARNED
//   Asset Hub     Scarcity.NftsByOwner  -> what is MINTED, and where
//
// Every credit becomes one item. Unminted credits split by Asset Hub's
// nft-claims state (chain/pallets/claims.ts): root not arrived ->
// Earned, root present and leaf unclaimed -> Claimable (both render
// wrapped, `pending: true`; Claimable additionally carries
// `claimable: true` for Phase 2's actions). CLAIMED credits are dropped
// from the shelf: the shared purse convention means their item appears
// via the scan on its own, and ownership is the whole story the shelf
// tells. Which credit an item came from is unrecorded on-chain anyway —
// pallet-nft-claims' claim mints with EMPTY metadata
// (`mint_without_deposit(.., Vec::new())`), so a claim-minted item
// carries no credit hash (such items key by instance id, see
// pallets/scarcity.ts); the credit->instance link exists only in the
// CreditClaimed event (archive walk).
//
// Results land in the collection store — the only data source: cache-
// first render, boot resolution, generation/remount logic and flow
// events all key off what this loop delivers.
//
// Deliberately silent when it has nothing trustworthy to say:
//   - legacy embedded host (no product-sdk container) -> inert: no
//     connection may be opened, so the shelf shows cache or boot-timeout
//   - ?mock= session -> inert (mocks must never mix with chain data)

import { Enum } from 'polkadot-api'
import { getChainApis, destroyClients, type AssetHubApi } from './client'
import { setChainSyncStatus } from './status'
import { fetchOwnedAt, firstFreePurse, findPurseHolding } from './pallets/scarcity'
import { fetchCredits, type Credit } from './pallets/credits'
import { fetchClaimStates, type ClaimState } from './pallets/claims'
import { getIdentitySource, currentIdentity, type PlayerIdentity } from './identity'
import { getSigner, getPurseSigner } from './signing'
import { submitClaim, type ClaimParams, type ClaimResult, type ClaimStatus } from './claim'
import { watchSubmission, type SubmitStatus, type SubmitResult } from './submit'
import { hasDevOverride } from './devIdentity'
import { devRootPathOf } from './derive'
import { hostPurseSource, type PurseSource } from './purses'
import { devPurseSource } from './devPurses'
import { isEmbedded, isInContainer } from '../host/embed'
import { deliverCollection } from '../collection/store'
import { sendFlowEvent } from '../host/send'
import { normalizeHash } from '../lib/hash'
import { readJson, writeJson } from '../lib/storage'
import { withDeadline } from '../lib/deadline'
import { findMock } from '../devMocks'
import type { OwnedNft } from '../collection/types'

// How often to re-read once healthy. Polling both chains together keeps
// the first cut simple (the design's "watch the credit map" refinement
// can replace the People Chain leg later).
const REFRESH_MS = 30_000
// A poll that outlives this is a wedged connection (e.g. the socket died
// during laptop sleep), not a slow one: without a deadline the await
// never settles and the sync silently freezes forever.
const POLL_TIMEOUT_MS = 30_000
// Error backoff: exponential between these bounds.
const BACKOFF_MIN_MS = 5_000
const BACKOFF_MAX_MS = 60_000

let running = false
let timer: number | undefined
let unsubscribers: (() => void)[] = []
// Bumped on every stop/input change so an in-flight fetch that resolves
// late can tell it's stale and drop its result.
let generation = 0
// The running loop's restart(), exposed so a finished claim can force an
// immediate re-poll (the minted item then appears unwrapped without waiting
// out the 30s cycle). Null when the sync isn't running.
let triggerPoll: (() => void) | null = null

/** Owned items win over credits with the same hash; unminted credits
 *  render as wrapped (`pending`), Claimable ones flagged for Phase 2's
 *  actions; claimed credits are dropped — the shared purse convention
 *  means their item shows up via the scan on its own. Store keys are
 *  normalized (lowercase, no 0x), so compare the same way. */
function mergeShelf(
  owned: OwnedNft[],
  credits: Credit[],
  claimStates: Map<string, ClaimState>
): OwnedNft[] {
  const mintedKeys = new Set(owned.map((o) => normalizeHash(o.hash)))
  const earned: OwnedNft[] = []
  for (const credit of credits) {
    const key = normalizeHash(credit.hash)
    if (mintedKeys.has(key)) continue
    const state = claimStates.get(credit.hash) ?? 'earned'
    if (state === 'claimed') continue
    earned.push({
      hash: credit.hash,
      pending: true,
      ...(state === 'claimable' ? { claimable: true } : {}),
      ...(credit.awardedAt !== undefined ? { mintedAt: credit.awardedAt } : {}),
      // Carried so the mint flow can re-fetch this credit's inclusion proof
      // at claim time (chain/claim.ts) without another shelf lookup.
      ...(credit.awardBlock !== undefined ? { awardBlock: credit.awardBlock } : {})
    })
  }
  return [...owned, ...earned]
}

// ---- purse scan -------------------------------------------------------------
// The player identity picks the purse subtree (a PurseSource — host
// product accounts in a container, a dev root otherwise, see purses.ts)
// which gets scanned gap-limit style, batches of SCAN_BATCH, stopping
// after a fully-empty batch. Occupied indexes are remembered in
// localStorage so purses past a gap (emptied by transfers) stay visible
// on later visits.

const SCAN_BATCH = 10
const SCAN_MAX = 1_000
const SCAN_CACHE_PREFIX = 'pkt_purse_scan_v1:'

function loadScanCache(cacheKey: string): number[] {
  const v = readJson<unknown>(SCAN_CACHE_PREFIX + cacheKey)
  return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n >= 0 && n < SCAN_MAX) : []
}
function saveScanCache(cacheKey: string, occupied: number[]): void {
  writeJson(SCAN_CACHE_PREFIX + cacheKey, occupied)
}

/** The owned items of a purse subtree. Gap-limit: the window always
 *  extends SCAN_BATCH indexes past the last occupied purse, so the walk
 *  ends once a full trailing batch is empty. The cache remembers the
 *  occupied layout, letting a steady-state poll cover it all in ONE
 *  batched read (a first visit, or growth past the window, pays one
 *  extra round per SCAN_BATCH extension). Scanning always starts at 0 —
 *  claims mint into the FIRST free purse, so low indexes are exactly
 *  where new items appear. */
async function scanOwned(assetHub: AssetHubApi, source: PurseSource): Promise<OwnedNft[]> {
  const owned: OwnedNft[] = []
  const occupied: number[] = []
  const probe = async (indexes: number[]): Promise<void> => {
    const addresses = await Promise.all(indexes.map((i) => source.addressAt(i)))
    const reads = await fetchOwnedAt(assetHub, addresses)
    reads.forEach((r, k) => {
      if (!r.occupied) return
      occupied.push(indexes[k])
      if (r.item) owned.push(r.item)
    })
  }

  const remembered = loadScanCache(source.cacheKey)
  const known = remembered.length > 0 ? Math.max(...remembered) : -1
  // First window: everything the cache knows plus one empty-batch margin.
  let limit = Math.min(Math.max(SCAN_BATCH, known + 1 + SCAN_BATCH), SCAN_MAX)
  let start = 0
  for (;;) {
    await probe(Array.from({ length: limit - start }, (_, k) => start + k))
    const tailStart = limit - SCAN_BATCH
    if (limit >= SCAN_MAX || !occupied.some((i) => i >= tailStart)) break
    start = limit
    limit = Math.min(limit + SCAN_BATCH, SCAN_MAX)
  }
  saveScanCache(source.cacheKey, occupied)
  return owned
}

/** This session's purse subtree. An identity that is a dev-held account
 *  (?player=bob, or a DEV_PHRASE root address) scans its own dev subtree
 *  in EVERY mode — the explicit override works inside a host too.
 *  Otherwise a container scans host product accounts; a host WITHOUT the
 *  product-account capability (all of today's hosts) falls back to the
 *  dev derivation as a TEMPORARY stand-in, same as a plain-browser
 *  session: the identity's dev root, or the bare dev-player root, the
 *  default shelf. */
async function purseSourceOf(identity: PlayerIdentity | null): Promise<PurseSource> {
  if (identity?.kind === 'account') {
    const root = devRootPathOf(identity.address)
    if (root !== null) return devPurseSource(root)
  }
  if (isInContainer) {
    const source = await hostPurseSource()
    if (source) return source
  }
  return devPurseSource('')
}

export function startChainSync(): void {
  if (running) return
  // Inert only when a mock will actually load (App.tsx resolves through
  // the same findMock) — a mistyped ?mock= name falls through to the
  // live shelf instead of silently disabling both data sources.
  const mockParam = new URLSearchParams(window.location.search).get('mock')
  if (mockParam && findMock(mockParam)) return
  // A legacy embedded host (no product-sdk container) gets no connection
  // of any kind — the chain layer stays inert. An explicit ?player=
  // override is the QA exception; it polls over the dev sockets.
  if (isEmbedded && !isInContainer && !hasDevOverride()) return
  running = true

  let identity: PlayerIdentity | null = null
  let backoff = BACKOFF_MIN_MS

  async function poll(): Promise<void> {
    const gen = generation
    try {
      const { owned, credits, claimStates } = await withDeadline(
        (async () => {
          // Resolved per poll: after a wedged connection is destroyed
          // below, the next poll builds fresh clients instead of reusing
          // dead ones. Inside the deadline so a hung container handshake
          // also trips it.
          const apis = await getChainApis()
          if (!apis) throw new Error('no chain connection this session')
          const source = await purseSourceOf(identity)
          // People Chain is optional: without it (or without an identity)
          // the shelf is owned-items-only, never an error. Claim states
          // depend only on the credits, so that leg chains behind the
          // People read and overlaps the owned scan.
          const [owned, creditState] = await Promise.all([
            scanOwned(apis.assetHub, source),
            (async () => {
              const credits = apis.people && identity ? await fetchCredits(apis.people, identity) : []
              const claimStates = await fetchClaimStates(apis.assetHub, credits)
              return { credits, claimStates }
            })()
          ])
          return { owned, ...creditState }
        })(),
        POLL_TIMEOUT_MS,
        'chain poll'
      )
      if (!running || gen !== generation) return
      backoff = BACKOFF_MIN_MS
      setChainSyncStatus('ok')
      deliverCollection({ owned: mergeShelf(owned, credits, claimStates) })
      timer = window.setTimeout(() => { void poll() }, REFRESH_MS)
    } catch (err) {
      if (!running || gen !== generation) return
      const detail = err instanceof Error ? err.message : String(err)
      console.warn('[chain] sync failed', err)
      setChainSyncStatus('error')
      sendFlowEvent({ type: 'flow.error', phase: 'chain', detail })
      // Every failure retries — including a host refusing Asset Hub
      // (ChainNotSupportedError): sockets are never a production fallback,
      // so retrying the probe is the only route back, and a host build
      // gaining the chain is picked up by it. Assume the worst (a dead
      // connection) and rebuild: destroying costs one reconnect, while
      // reusing a wedged client hangs every later poll.
      destroyClients()
      timer = window.setTimeout(() => { void poll() }, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  function restart(): void {
    generation++
    if (timer !== undefined) window.clearTimeout(timer)
    backoff = BACKOFF_MIN_MS
    // A container always has purses to scan, and outside any host the dev
    // purse scan always has a root to walk (the dev player by default) —
    // both poll even with no identity yet.
    if (identity || isInContainer || !isEmbedded) void poll()
  }

  triggerPoll = restart
  unsubscribers = [
    getIdentitySource().subscribe((next) => {
      identity = next
      restart()
    })
  ]
}

/** Force an immediate re-poll (e.g. right after a successful claim) so the
 *  shelf reflects the new on-chain state without waiting out the refresh
 *  interval. No-op when the sync isn't running. */
export function refreshChainSync(): void {
  triggerPoll?.()
}

/** Spend a claimable credit: gather this session's connection, identity,
 *  signer, and purse subtree, submit the claim (chain/claim.ts), and on
 *  success force an immediate re-poll so the minted item appears unwrapped.
 *  Resolves with the outcome; never rejects. */
export async function claimCredit(
  params: ClaimParams,
  onStatus: (status: ClaimStatus) => void
): Promise<ClaimResult> {
  const identity = currentIdentity()
  if (!identity) return { ok: false, error: 'no player identity to claim as' }
  const apis = await getChainApis()
  if (!apis) return { ok: false, error: 'no chain connection this session' }
  const signer = await getSigner(identity)
  if (!signer) return { ok: false, error: 'this session cannot sign a claim' }
  const source = await purseSourceOf(identity)
  const result = await submitClaim(apis, identity, source, params, signer, onStatus)
  if (result.ok) refreshChainSync()
  return result
}

/** What the caller needs to send one owned item: which item (its identity
 *  hash), and the dev root of the recipient whose subtree it lands in. */
export interface SendParams {
  hash: string
  recipientRoot: string
}

export type SendStatus = SubmitStatus
export type SendResult = SubmitResult

/** Send an owned item to another player: locate the purse currently HOLDING
 *  it (the sending key), sign as that purse (signing.ts — the host inside a
 *  container, the dev key otherwise, NEVER a fallback), and `Scarcity.transfer`
 *  it into the recipient's first EMPTY purse (so it lands on their shelf scan).
 *  On success forces an immediate re-poll so the sent item leaves this shelf.
 *  Resolves with the outcome; never rejects. */
export async function sendItem(
  params: SendParams,
  onStatus: (status: SendStatus) => void
): Promise<SendResult> {
  const identity = currentIdentity()
  if (!identity) return { ok: false, error: 'no player identity to send from' }
  const apis = await getChainApis()
  if (!apis) return { ok: false, error: 'no chain connection this session' }
  const senderSource = await purseSourceOf(identity)
  const holding = await findPurseHolding(apis.assetHub, senderSource, params.hash)
  if (!holding) return { ok: false, error: 'you no longer hold this item' }
  const signer = await getPurseSigner(identity, holding.index)
  if (!signer) return { ok: false, error: 'this session cannot sign a transfer' }
  const dest = await firstFreePurse(apis.assetHub, devPurseSource(params.recipientRoot))

  const tx = apis.assetHub.tx.Scarcity.transfer({ to: dest.address })
  // A purse key holds an NFT but no balance, so a plain signed transfer is
  // rejected at validation (Invalid::Payment). `Scarcity.transfer` is instead
  // authorized by the `AsScarcity` transaction extension, which turns the
  // signed purse-key origin into the NFT origin (fee-free "rested" path). It
  // must echo the purse's CURRENT instance + state nonce, or validation fails
  // (NftStateMismatch); a successful move bumps the nonce, invalidating any
  // other outstanding authorization. The transfer stays mortal (papi default)
  // so a stale authorization can't be replayed past its era.
  const options = {
    customSignedExtensions: {
      AsScarcity: {
        value: Enum('AsNft', { instance: holding.instance, state_nonce: holding.stateNonce })
      }
    }
  }
  const result = await watchSubmission(tx, signer, onStatus, options)
  if (result.ok) refreshChainSync()
  return result
}

/** Tear the sync down (dev panel loading a mock, tests). Safe to call
 *  when never started. */
export function stopChainSync(): void {
  if (!running) return
  running = false
  generation++
  triggerPoll = null
  if (timer !== undefined) window.clearTimeout(timer)
  for (const off of unsubscribers) off()
  unsubscribers = []
  destroyClients()
}
