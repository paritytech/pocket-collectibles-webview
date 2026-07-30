// Native bridge contract — single source of truth for all data crossing
// the webview boundary for the Collectibles catalogue.
//
// This mirrors the game-results webview's bridge conventions
// (buffer-or-deliver globals, web→native flow events) but carries a
// different payload: the user's *owned* collectibles rather than a
// single game's results.
//
// Lifecycle: native sets window.__COLLECTION__ before the webview
// finishes loading, OR calls window.setCollection(input) at any point
// after. It MAY also stream individual items in via window.pushNft(...)
// (useful when the owned set is large or arrives incrementally from the
// chain). All three paths converge on the same React state — see
// src/bridge/collection.ts.

/** A single collectible the user owns.
 *
 *  Sourced from the `Nfts` storage double-map (`(owner, Nft) -> u32`):
 *  `hash` is the second map key (the NFT hash) and `mintedAt` is the
 *  `u32` Unix-seconds value. Staged `NftCandidates` entries (held
 *  `NotPerson` reports awaiting resolution) are passed with
 *  `pending: true` and no meaningful timestamp.
 *
 *  The webview maps `hash` to a displayable image via the
 *  CollectableHashResolver-style resolver (src/collectibles/resolver.ts):
 *  the first 2 bytes pick rarity, the next 2 pick the image from the
 *  appropriate pool, indexed by the bundled cid_map.json. Images are
 *  served from the Polkadot Bulletin Chain IPFS gateway.
 *
 *  Identity is per-hash: two distinct hashes that happen to resolve to
 *  the same art are two distinct collectibles, each with its own tile. */
export interface OwnedNft {
  /** The 32-byte NFT hash as a 64-character hex string, optionally
   *  prefixed with `0x`. Case-insensitive; leading `0x` is stripped.
   *  Malformed hashes fall back to the first catalogue image and log a
   *  warning (they never crash the gallery). */
  hash: string
  /** Unix-seconds timestamp the on-chain entry was most recently written
   *  (the `u32` value of the `Nfts` map). Drives "newest first" sort and
   *  per-game version grouping. Optional — omit for pending candidates or
   *  when unknown; such items sort to the end. */
  mintedAt?: number
  /** True iff this is a staged `NftCandidates` entry — earned-but-held,
   *  not yet finalised into `Nfts`. Renders in a dimmed "pending" state
   *  with no mint date. Defaults to false (a confirmed mint). */
  pending?: boolean
  /** OPTIONAL (bridge v2): the registry id of the collection this item was
   *  minted into (PRODUCTION: native maps the pallet_nfts collection id to
   *  the claim-pallet registry entry). Drives collection labels + sort. */
  collectionId?: string
  /** OPTIONAL (bridge v2): set when the item can't be transferred right
   *  now, with a player-worded reason the UI shows verbatim (PRD: "if a
   *  transfer is blocked, the UI shows why"). PRODUCTION sources: item or
   *  collection transfer locks, a future cooldown (UJ-5). */
  transferBlocked?: { reason: string }
  /** OPTIONAL (bridge v2, UJ-6): the game this item is playable in.
   *  PRODUCTION: from the collection's jollity_api metadata (the
   *  game-link field the PRD asks to freeze into the interface). Absent →
   *  no game action shown. */
  gameLink?: { label: string; url: string }
}

export interface CollectionInput {
  /** Every collectible the user owns: confirmed mints plus, optionally,
   *  pending candidates (flagged via `OwnedNft.pending`). Order is
   *  irrelevant — the webview sorts. Duplicate hashes are de-duped
   *  (last write wins), mirroring the on-chain map's key uniqueness. */
  owned: OwnedNft[]
  /** Optional display name for the header, e.g. "ERIN". Max 24 chars;
   *  native should sanitize. */
  displayName?: string
  /** OPTIONAL (bridge v2, additive per the §12 versioning rules): unminted
   *  claim credits, rendered as "tickets" with previews and a mint flow.
   *  v1 hosts that omit this field get the classic owned-only gallery. */
  tickets?: Ticket[]
}

// ---- Bridge v2: tickets + mint requests (all additive) -------------------
//
// PRODUCTION SOURCE: tickets are the player's claim credits on the People
// Chain (Game pallet storage). Native reads them alongside `Nfts` /
// `NftCandidates` and delivers them here. They become mintable once the
// merkle root covering them has reached the Asset Hub claim pallet via XCM.

export type TicketState =
  /** Credit exists on the People Chain but its merkle root hasn't been
   *  synced to Asset Hub yet — visible, previewable, but a mint would fail.
   *  Native watches the root sync and re-delivers when it lands. */
  | 'finalizing'
  /** Provable against the synced root: mint away. */
  | 'mintable'

/** An unminted claim credit. Tickets are NOT bound to a collection or an
 *  outcome — they entitle the holder to mint ONE item of the ticket's
 *  RARITY TIER, chosen by the player from any registered collection. The
 *  tier is derived from the hash's rarity band (bytes 0–1), the same roll
 *  the games use, so a ticket visibly promises "a rare" or "a common". */
export interface Ticket {
  /** 32-byte credit hash, 64 hex chars, optional 0x prefix — same
   *  normalization rules as OwnedNft.hash. */
  hash: string
  state: TicketState
  /** The game cycle this credit belongs to (pallet-scarcity-people groups
   *  credits into cycles; the merkle root is sealed per cycle). Native
   *  needs it to build proofs/claims — the page just passes it through. */
  cycleId?: number
  /** Unix seconds when the credit is cleaned from the People Chain (end of
   *  the retention window). Drives all expiry UX; omit only if unknown.
   *  NOTE: the current runtime has NO time-based expiry — cleanup happens
   *  only when a cycle is fully claimed — so until a retention TTL lands
   *  on-chain, this value is product policy supplied by native. */
  expiresAt?: number
}

/** Web → native commands (bridge v2). Every request carries a web-generated
 *  `requestId`; native answers each one via `window.deliverRequestUpdate`,
 *  always reaching a terminal status. Posted on the same `collectibles`
 *  transport as FlowEvent. */
export type BridgeRequest =
  | {
      type: 'request.mint'
      requestId: string
      /** COLLECTION-ONLY model: each ticket mints into a chosen collection;
       *  the collection's minting contract derives the item deterministically
       *  from the credit hash (no per-item choice). Batch is the primary
       *  path — one request carries every ticket being minted. */
      mints: Array<{
        ticketHash: string        // must be a `mintable` credit
        collectionId: string
      }>
      /** DEV ONLY: compress the mock's staged timings so the reveal starts
       *  immediately — for rapidly comparing the reveal experience. Native
       *  ignores this. */
      demo?: boolean
    }
  | {
      type: 'request.send'
      requestId: string
      /** Hash of the owned item to transfer. */
      itemHash: string
      /** Asset Hub address, if the page already knows it. Omitted → native
       *  presents its contact picker and reports the chosen recipient in
       *  the update stream (PRODUCTION: contacts live native-side; the
       *  page never sees the address book). */
      recipient?: string
    }
  | {
      type: 'request.open_game'
      requestId: string
      /** The item's gameLink.url. PRODUCTION: native deep-links into the
       *  game client (or its DIM route); the webview never navigates
       *  itself. Native acks via deliverRequestUpdate (done | failed). */
      url: string
    }

/** Coarse request state. Terminal: 'done' (per-item results attached),
 *  'failed' (request-level error), 'rejected' (user declined in the native
 *  approval sheet — a choice, not an error). */
export type RequestStatus =
  | 'received'
  | 'awaitingApproval'
  | 'building'
  | 'submitted'
  | 'inBlock'
  | 'done'
  | 'failed'
  | 'rejected'

export interface RequestItemUpdate {
  ticketHash: string
  /** Batches are NON-ATOMIC: each ticket succeeds or fails on its own. A
   *  failed ticket's credit is NEVER consumed — it stays mintable. */
  status: 'pending' | 'minted' | 'failed'
  /** The minted item's hash on success. Always equals the previewed
   *  outcome — minting contracts are deterministic and immutable. */
  itemId?: string
  /** Human-readable failure reason, shown to the user as-is. */
  reason?: string
}

/** Native → web progress/result stream for one request, injected via
 *  `window.deliverRequestUpdate` (registered in bridge/requests.ts). */
export interface RequestUpdate {
  requestId: string
  status: RequestStatus
  /** 0..1, meaningful during 'building' (merkle proof construction — a
   *  backgroundable native job, never a blocking spinner in the UI). */
  progress?: number
  /** Per-ticket outcomes; authoritative once status reaches 'inBlock'. */
  items?: RequestItemUpdate[]
  /** For request.send: who the item is going to (display handle), known
   *  once the native contact picker resolves. */
  recipient?: string
  /** Request-level reason for 'failed' / 'rejected'. */
  reason?: string
}

// Web→native events. Native may ignore any of these; they exist for
// telemetry, native chrome (e.g. a back button), and lifecycle.
export type FlowEvent =
  /** Fired once after first paint — the webview is alive and listening. */
  | { type: 'flow.ready' }
  /** The gallery has mounted and run its entrance. */
  | { type: 'flow.gallery_shown'; count: number }
  /** User opened a collectible's detail view. */
  | { type: 'flow.item_opened'; hash: string }
  /** User closed the detail view, back to the gallery. */
  | { type: 'flow.item_closed'; hash: string }
  /** Webview-side error worth surfacing for telemetry. `phase` identifies
   *  the area (e.g. 'boot_timeout', 'assets'); `detail` is optional. */
  | { type: 'flow.error'; phase: string; detail?: string }
  /** User asked to dismiss the webview (e.g. tapped the close affordance).
   *  Native should tear down the WebView. */
  | { type: 'flow.close' }
