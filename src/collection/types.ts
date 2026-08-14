// Data contract of the collection store — the shapes every delivery
// (chain sync, cache seed, dev mocks) uses.

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
