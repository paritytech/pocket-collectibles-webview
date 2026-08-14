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
  /** True iff a pending item's credit is verifiable on Asset Hub (its
   *  merkle root arrived, its leaf is unclaimed), so a claim would mint
   *  it — the design's Claimable state, as opposed to merely Earned.
   *  Renders identically to `pending` today; Phase 2's actions key off
   *  it. Meaningless without `pending`. Defaults to false. */
  claimable?: boolean
  /** On-chain display name (three-level metadata key `name`), when the
   *  chain-read path resolved one. Overrides the catalogue-derived name. */
  name?: string
  /** Resolved artwork URL (from the metadata key `image`, served via the
   *  IPFS gateway). Overrides the catalogue-derived art. */
  imageUrl?: string
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
