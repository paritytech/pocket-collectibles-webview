// Mock NATIVE side of bridge v2.
//
// The UI is written as if the real native host were present: it calls
// `sendBridgeRequest()` and consumes `window.setCollection` /
// `window.deliverRequestUpdate` exactly as production will. This module
// impersonates the native app by installing the Android-shape transport
// (`window.collectibles.postMessage`) and calling those injected globals
// back — so the production serialization path is exercised end-to-end and
// no UI code knows the mock exists.
//
// Every mocked behavior below carries a PRODUCTION note describing what the
// real native app + chains do at that moment. This file is the map of the
// real integration work.
//
// Installed only in dev/mock sessions (see installMockNative's guard) —
// a real native host wins automatically because it registers the transport
// before this module would.

import type {
  BridgeRequest,
  CollectionInput,
  OwnedNft,
  RequestItemUpdate,
  RequestUpdate,
  Ticket
} from '../bridge/types'
import { RARE_THRESHOLD } from '../collectibles/resolver'
import { outcomeIndex } from '../collectibles/mintCollections'

/** Any ticket whose hash ends with this suffix fails its mint — mock
 *  scenarios craft exactly one such ticket to exercise the failure path.
 *  PRODUCTION failure sources at the same point: the root was re-organized
 *  before inclusion, the derived item id collided, or the transaction was
 *  dropped from the pool. In every case the claim pallet only consumes a
 *  credit on SUCCESSFUL mint, so the ticket survives (PRD hard rule: a
 *  failed mint never consumes a credit, and never aborts the rest of the
 *  batch — batches are non-atomic). */
export const MOCK_FAIL_SUFFIX = '00ff'

/** How long a mock 'finalizing' ticket takes to become mintable. */
const FINALIZE_MS = 6_000

// The mock's mirror of what native believes the current collection is.
// PRODUCTION: this state doesn't exist in the webview at all — native owns
// it, sourced from chain reads (People Chain Game pallet for credits,
// Asset Hub pallet_nfts for owned items).
let current: CollectionInput = { owned: [] }
let installed = false
let finalizeTimers: number[] = []

type SetCollection = (input: CollectionInput) => void
type DeliverRequestUpdate = (update: RequestUpdate) => void

function callSetCollection(input: CollectionInput): void {
  const w = window as unknown as { setCollection?: SetCollection }
  w.setCollection?.(structuredClone(input))
}

function callDeliverRequestUpdate(update: RequestUpdate): void {
  const w = window as unknown as { deliverRequestUpdate?: DeliverRequestUpdate }
  w.deliverRequestUpdate?.(update)
}

function normalize(hash: string): string {
  let h = hash.trim()
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2)
  return h.toLowerCase()
}

/** Load a scenario as if native had just read the chain and delivered it.
 *  The dev panel and the `?mock=` boot param route through here (instead of
 *  calling window.setCollection directly) so the mock can mirror the state
 *  and arm the finalizing→mintable flips. */
export function loadScenario(input: CollectionInput): void {
  // Cancel flips armed for a previous scenario — its tickets are gone.
  for (const id of finalizeTimers) window.clearTimeout(id)
  finalizeTimers = []

  current = structuredClone(input)
  callSetCollection(current)

  // PRODUCTION (per pallet-scarcity-people): credits were written during
  // the game via note_credit into the current CYCLE. The cycle is then
  // sealed (seal_cycle builds a base-2 merkle tree and XCM-Transacts
  // ingest_root to Asset Hub). A ticket is 'finalizing' until the root is
  // observable on Asset Hub — the concrete signal native watches is
  // pallet-scarcity-hub's `Roots(cycle)` storage appearing. When it does,
  // native re-delivers the collection with the ticket flipped to
  // 'mintable'. (This answers the PRD's open "poll or push" question:
  // poll/subscribe to Roots(cycle) on Asset Hub.)
  for (const t of current.tickets ?? []) {
    if (t.state !== 'finalizing') continue
    const hash = normalize(t.hash)
    const id = window.setTimeout(() => {
      const ticket = (current.tickets ?? []).find((x) => normalize(x.hash) === hash)
      if (!ticket || ticket.state !== 'finalizing') return
      ticket.state = 'mintable'
      callSetCollection(current)
    }, FINALIZE_MS)
    finalizeTimers.push(id)
  }
}

/** Construct the minted item's hash for a ticket claimed into a collection:
 *  the collection derives a pool index from the credit hash (outcomeIndex),
 *  which we bake into bytes 0–3 so the item resolves to exactly what the
 *  reveal previewed. Same ticket + collection → same item, forever.
 *  PRODUCTION: the collection's minting contract does this on-chain. */
function mintedItemHash(ticketHash: string, collectionId: string): string {
  const rare = parseInt(ticketHash.slice(0, 4), 16) < RARE_THRESHOLD
  const band = rare ? '0000' : '8000'
  const idx = outcomeIndex(ticketHash, rare ? 'rare' : 'common', collectionId)
  const pick = (idx & 0xffff).toString(16).padStart(4, '0')
  return band + pick + ticketHash.slice(8)
}

/** The staged response to one request.mint — the mock's re-enactment of the
 *  full native + chain pipeline, one deliverRequestUpdate per stage. */
function handleMint(req: Extract<BridgeRequest, { type: 'request.mint' }>): void {
  const requestId = req.requestId
  const mints = req.mints.map((m) => ({ ...m, ticketHash: normalize(m.ticketHash) }))

  // Per-item outcomes, decided up front (deterministically) so 'inBlock'
  // and 'done' agree. The minted item id resolves to exactly the item the
  // player chose.
  const items: RequestItemUpdate[] = mints.map((m) => {
    if (m.ticketHash.endsWith(MOCK_FAIL_SUFFIX)) {
      // `reason` is shown to the player verbatim, so it speaks their
      // language — no crypto vocabulary (the real cause here would be a
      // stale proof / dropped tx; the user just needs "it didn't happen
      // and nothing was lost").
      return {
        ticketHash: m.ticketHash,
        status: 'failed',
        reason: "That one didn't go through — your ticket is safe"
      }
    }
    return { ticketHash: m.ticketHash, status: 'minted', itemId: mintedItemHash(m.ticketHash, m.collectionId) }
  })
  const pending: RequestItemUpdate[] = mints.map((m) => ({ ticketHash: m.ticketHash, status: 'pending' }))

  // Dev demo mints compress the pre-reveal stream so the reveal starts
  // right away; real mints keep the full, honest pacing.
  const k = req.demo ? 0.12 : 1
  const stage = (delay: number, update: Omit<RequestUpdate, 'requestId'>) => {
    window.setTimeout(() => callDeliverRequestUpdate({ requestId, ...update }), delay * k)
  }

  // PRODUCTION: the native bridge handler validates the request — every
  // hash must be a credit the user holds, in 'mintable' state (root synced).
  // A validation miss answers status:'failed' with a reason instead.
  stage(0, { status: 'received', items: pending })

  // PRODUCTION: native presents its transaction approval sheet. Fees are
  // PGAS-sponsored via the personhood allowance — NO fee or gas figure is
  // shown anywhere, ever (PRD hard rule). The user confirms with
  // biometrics; declining answers status:'rejected' (a choice, not an
  // error — nothing consumed). The webview just waits under its own UI.
  stage(400, { status: 'awaitingApproval', items: pending })

  // PRODUCTION (per pallet-scarcity-people): proofs do NOT need on-device
  // tree construction — the People Chain pallet exposes a runtime-API-
  // shaped helper `generate_proof(cycle, owner, credit_hash)` that rebuilds
  // the trie from stored credits and returns the encoded base-2 proof
  // (≤16 KB). Native calls it once per ticket. Still a backgroundable job
  // with progress (PRD hard rule: never a blocking spinner); a dedicated
  // RPC endpoint for it is a known gap in the runtime repo.
  stage(1200, { status: 'building', progress: 0.35, items: pending })
  stage(2000, { status: 'building', progress: 0.8, items: pending })

  // PRODUCTION (per pallet-scarcity-hub): there is NO batch-claim
  // extrinsic — `claim(cycle, owner, credit_hash, timestamp, collection,
  // proof)` is single-credit. Native signs and submits ONE transaction per
  // ticket, sequentially. Batch UX is preserved because each claim
  // succeeds/fails independently (per-item results below); an earlier
  // failure never blocks later claims. The signer must BE the credit
  // owner (no relayers in v1), and the item mints to that same account —
  // which settles the PRD's open mint-destination question for now.
  stage(2600, { status: 'submitted', items: pending })

  // PRODUCTION (per pallet-scarcity-hub): each claim verifies its merkle
  // proof against the ingested root, checks the target collection is in
  // ApprovedCollections (and the approval isn't stale — collection owner
  // changed → CollectionApprovalStale, a new blocked-reason to surface),
  // then mints an ordinary transferable pallet_nfts item. The item
  // deposit is funded by the COLLECTION OWNER (deposit_collection_owner),
  // so the claimant needs no balance for deposits — but transaction FEES
  // are not yet waived on-chain: the "never a visible gas purchase" NFR
  // still needs the PGAS / feeless wiring. Failure sources: InvalidProof,
  // AlreadyClaimed, CollectionNotApproved/Stale, or an item-id collision
  // (POC derives the id as FirstFourBytes(credit_hash)). A failed claim
  // leaves the credit fully intact and retryable.
  stage(3200, { status: 'inBlock', items })

  stage(3800, { status: 'done', items })

  // PRODUCTION: native never synthesizes the post-mint collection — after
  // finality it re-reads chain state (Asset Hub pallet_nfts for items,
  // People Chain `Credits(cycle, ...)` for remaining credits, Asset Hub
  // `Claimed(cycle, hash)` for claim status) and re-delivers the whole
  // thing. deliverRequestUpdate is UX feedback; setCollection is truth.
  // Note: when a cycle's LAST credit is claimed, the runtime runs its
  // cleanup handshake (Asset Hub → People deletes the cycle's credits →
  // ack back); there is currently no TIME-based expiry on-chain, so the
  // ticket `expiresAt` the app shows is product policy, not chain state.
  window.setTimeout(() => {
    const mintedAt = Math.floor(Date.now() / 1000)
    const succeeded = new Set(
      items.filter((i) => i.status === 'minted').map((i) => i.ticketHash)
    )
    const newItems: OwnedNft[] = items
      .filter((i): i is RequestItemUpdate & { itemId: string } => i.status === 'minted' && !!i.itemId)
      .map((i) => ({
        hash: i.itemId,
        mintedAt,
        collectionId: mints.find((m) => m.ticketHash === i.ticketHash)?.collectionId
      }))
    const keptTickets: Ticket[] = (current.tickets ?? []).filter(
      (t) => !succeeded.has(normalize(t.hash))
    )
    current = {
      ...current,
      owned: [...current.owned, ...newItems],
      tickets: keptTickets
    }
    callSetCollection(current)
  }, 4400 * k)
}

/** Mock recipients "from the address book" — PRODUCTION: the contact
 *  picker is a NATIVE sheet over the People Chain contact list; the page
 *  never sees the address book, only the chosen recipient's handle. */
const MOCK_CONTACTS = ['quartzwilds.18', 'lumenfox.03', 'pebblewrit.55']

/** The staged response to one request.send — native contact pick, approval,
 *  transfer, and the truth delivery in which the item leaves the gallery. */
function handleSend(req: Extract<BridgeRequest, { type: 'request.send' }>): void {
  const requestId = req.requestId
  const itemHash = normalize(req.itemHash)
  const recipient =
    req.recipient ?? MOCK_CONTACTS[parseInt(itemHash.slice(0, 2), 16) % MOCK_CONTACTS.length]!

  const stage = (delay: number, update: Omit<RequestUpdate, 'requestId'>) => {
    window.setTimeout(() => callDeliverRequestUpdate({ requestId, ...update }), delay)
  }

  // PRODUCTION: native validates the item is owned and transferable
  // (pallet_nfts ItemSetting::Transferable, no lock, no future cooldown) —
  // a blocked item answers status:'failed' with the player-worded reason.
  stage(0, { status: 'received' })

  // PRODUCTION: native presents its contact picker (recipient omitted in
  // the request) and then the approval sheet — fee-free to the user, no
  // fee shown. Declining either answers status:'rejected'.
  stage(500, { status: 'awaitingApproval' })

  // PRODUCTION: a plain pallet_nfts::transfer extrinsic on Asset Hub,
  // signed via the existing TransactionSigningHandler.
  stage(1600, { status: 'submitted', recipient })
  stage(2400, { status: 'inBlock', recipient })
  stage(3000, { status: 'done', recipient })

  // PRODUCTION: native re-reads owned items after finality; the sent item
  // is simply absent from the next setCollection. Truth, not a patch.
  window.setTimeout(() => {
    current = {
      ...current,
      owned: current.owned.filter((o) => normalize(o.hash) !== itemHash)
    }
    callSetCollection(current)
  }, 3600)
}

/** request.open_game: the whole action is native's — it deep-links into
 *  the game client (or routes to the game's DIM), suspending this webview.
 *  The mock can only acknowledge; the page shows a brief "opening…" note.
 *  PRODUCTION: a failed route (game not installed / dead link) answers
 *  status:'failed' with a player-worded reason. */
function handleOpenGame(req: Extract<BridgeRequest, { type: 'request.open_game' }>): void {
  console.debug('[mockNative] would deep-link to game:', req.url)
  window.setTimeout(() => {
    callDeliverRequestUpdate({ requestId: req.requestId, status: 'done' })
  }, 400)
}

/** Install the mock transport. No-op if a real native host is present
 *  (its handler registered before our JS ran) or if already installed. */
export function installMockNative(): void {
  if (installed) return
  const w = window as unknown as Record<string, unknown>
  const hasIOS = !!(window.webkit?.messageHandlers?.collectibles)
  const hasAndroid = !!w.collectibles
  if (hasIOS || hasAndroid) return
  installed = true

  // Marker so App.tsx can keep the desktop phone-frame preview: detecting a
  // `collectibles` transport normally means "embedded in a real WebView".
  w.__MOCK_NATIVE__ = true

  // The exact Android transport shape: an object named `collectibles` with
  // postMessage(jsonString). sendFlowEvent/sendBridgeRequest find it and
  // exercise their production serialization path.
  w.collectibles = {
    postMessage(json: string): void {
      let msg: { type?: string } & Record<string, unknown>
      try {
        msg = JSON.parse(json)
      } catch {
        console.warn('[mockNative] non-JSON message', json)
        return
      }
      if (msg.type === 'request.mint') {
        handleMint(msg as unknown as Extract<BridgeRequest, { type: 'request.mint' }>)
        return
      }
      if (msg.type === 'request.send') {
        handleSend(msg as unknown as Extract<BridgeRequest, { type: 'request.send' }>)
        return
      }
      if (msg.type === 'request.open_game') {
        handleOpenGame(msg as unknown as Extract<BridgeRequest, { type: 'request.open_game' }>)
        return
      }
      // PRODUCTION: flow.* telemetry feeds native analytics/lifecycle
      // (and per the PRD's privacy rule must never carry a PersonalId —
      // hashes and addresses only). The mock just logs it.
      console.debug('[mockNative] flow event', msg)
    }
  }
}
