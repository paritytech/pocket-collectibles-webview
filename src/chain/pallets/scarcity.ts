// On-chain read path for pallet-scarcity (Asset Hub).
//
// Originally vendored from the scarcity-tools SDK read surface and since
// migrated to the typed api over generated descriptors — the query shapes
// now come from .papi/ metadata, so a pallet change surfaces in
// `papi update` + typecheck rather than by drifting from the SDK.
//
// Chain model (pallet-scarcity, "coinage"): `NftsByOwner: AccountId -> Nft`
// is a plain map — an account holds at most ONE NFT, so a player's
// collection is a set of purse addresses, one item each. The 32-byte hash
// the gallery keys art/rarity off is NOT part of the Nft value; by
// convention it lives in metadata under the key "hash", resolved
// instance -> item -> collection (most specific wins).

import { Binary } from 'polkadot-api'
import type { OwnedNft } from '../../bridge/types'
import type { AssetHubApi } from '../client'

/** Metadata key convention carrying the 32-byte identity hash. */
export const HASH_METADATA_KEY = 'hash'

// Reads resolve at "best" blocks: snappier than finality, and safe for a
// display-only shelf (a reorged read self-corrects on the next refresh).
const AT = { at: 'best' } as const

/** `Scarcity.NftsByOwner` value, as the descriptors type it. */
type Nft = NonNullable<
  Awaited<ReturnType<AssetHubApi['query']['Scarcity']['NftsByOwner']['getValue']>>
>

/** Effective metadata value for `key` across MANY nfts at once, resolved
 *  instance -> item -> collection, first match wins (mirrors the pallet's
 *  `instance_metadata_of`). One batched getValues per tier — a constant
 *  ≤3 round trips regardless of how many items the shelf holds, instead
 *  of up to 3 point reads per item. Result is positional: out[i] answers
 *  nfts[i]. Metadata keys/values are `Vec<u8>`, served as bytes. */
async function batchMetadataOf(
  api: AssetHubApi,
  nfts: Nft[],
  key: string
): Promise<(Uint8Array | undefined)[]> {
  const keyBytes = Binary.fromText(key)
  const out: (Uint8Array | undefined)[] = new Array(nfts.length).fill(undefined)
  let pending = nfts.map((_, i) => i)

  const take = (entries: ({ value: Uint8Array } | undefined)[]): void => {
    pending = pending.filter((i, k) => {
      const entry = entries[k]
      if (entry && entry.value instanceof Uint8Array) {
        out[i] = entry.value
        return false
      }
      return true
    })
  }

  take(await api.query.Scarcity.InstanceMetadata.getValues(
    pending.map((i) => [nfts[i].instance, keyBytes] as [bigint, typeof keyBytes]), AT))
  if (pending.length > 0) {
    take(await api.query.Scarcity.ItemMetadata.getValues(
      pending.map((i) => [nfts[i].collection, nfts[i].item, keyBytes] as [number, number, typeof keyBytes]), AT))
  }
  if (pending.length > 0) {
    take(await api.query.Scarcity.CollectionMetadata.getValues(
      pending.map((i) => [nfts[i].collection, keyBytes] as [number, typeof keyBytes]), AT))
  }
  return out
}

// The identity hash is immutable in practice (it IS the item's identity),
// so cache it per instance: repeat polls then cost one batched
// NftsByOwner read instead of up to three metadata reads per item.
// Name and image are NOT cached: key-value metadata is mutable (the
// pallet has no freeze), so the design's rule is refresh-on-access.
const hashCache = new Map<bigint, string>()

/** Display-metadata keys resolved alongside the identity hash. */
const NAME_METADATA_KEY = 'name'
const IMAGE_METADATA_KEY = 'image'

/*
* TEMPORARY SOLUTION TO OPEN QUESTION
* DEPENDENCY #17
* https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
*
* Which origin serves artwork bytes inside the sandbox, and whether there
* is an on-device cache. Dev choice mirroring the team's web-demo config
* until the platform answers.
*
*/
const IPFS_GATEWAY = 'https://gamingnet.substrate.dev'

/** Map an `image` metadata value to a fetchable URL: full http(s) URLs
 *  pass through; multibase CIDs (the bulletin convention) go through the
 *  gateway; anything else (e.g. `bulletin:<block>:<index>` refs) is not
 *  fetchable from the page and yields undefined. */
export function imageUrlOf(value: string): string | undefined {
  const v = value.trim()
  if (/^https?:\/\//i.test(v)) return v
  if (/^b[a-z2-7]{20,}$/.test(v)) return `${IPFS_GATEWAY}/ipfs/${v}`
  return undefined
}

/** One purse read: whether the address holds an NFT at all, and the
 *  displayable item when it does (an occupied purse whose item lacks the
 *  "hash" identity metadata is occupied with item null). */
export interface PurseRead {
  occupied: boolean
  item: OwnedNft | null
}

/** Positional reads — result[i] answers addresses[i]. The gap-limit purse
 *  scan (chain/start.ts) needs per-index occupancy, not just the items.
 *  All metadata resolves in ≤9 batched round trips total (3 tiers × 3
 *  keys, keys in parallel), independent of the item count. */
export async function fetchOwnedAt(api: AssetHubApi, addresses: string[]): Promise<PurseRead[]> {
  if (addresses.length === 0) return []
  const raws = await api.query.Scarcity.NftsByOwner.getValues(
    addresses.map((a) => [a] as [string]),
    AT
  )
  const reads: PurseRead[] = addresses.map(() => ({ occupied: false, item: null }))
  const present: { pos: number; nft: Nft }[] = []
  raws.forEach((raw, pos) => {
    if (raw !== undefined && raw !== null) present.push({ pos, nft: raw as Nft })
  })
  if (present.length === 0) return reads

  const nfts = present.map((p) => p.nft)
  const needHash = present.filter((p) => !hashCache.has(p.nft.instance))
  const [hashBytes, nameBytes, imageBytes] = await Promise.all([
    needHash.length > 0
      ? batchMetadataOf(api, needHash.map((p) => p.nft), HASH_METADATA_KEY)
      : Promise.resolve<(Uint8Array | undefined)[]>([]),
    batchMetadataOf(api, nfts, NAME_METADATA_KEY),
    batchMetadataOf(api, nfts, IMAGE_METADATA_KEY)
  ])
  // Only REAL hashes enter the cache: an item minted without the identity
  // key (every pallet claim — empty metadata, READ_PATH.md) keys as
  // `instance-<id>` this poll, but stays re-checked so a "hash" written
  // later (tooling backfill, a future runtime fix) is picked up without
  // a reload.
  needHash.forEach((p, k) => {
    const bytes = hashBytes[k]
    if (bytes) hashCache.set(p.nft.instance, Binary.toHex(bytes))
  })

  present.forEach((p, k) => {
    const hash = hashCache.get(p.nft.instance) ?? `instance-${p.nft.instance}`
    const item: OwnedNft = { hash, mintedAt: Number(p.nft.minted_at) }
    const name = nameBytes[k]
    if (name) item.name = Binary.toText(name)
    const image = imageBytes[k]
    if (image) {
      const url = imageUrlOf(Binary.toText(image))
      if (url) item.imageUrl = url
    }
    reads[p.pos] = { occupied: true, item }
  })
  return reads
}

/** Read the owned set for a list of purse addresses and map it into the
 *  gallery's bridge shape, resolving identity hash + display name +
 *  artwork per item. Addresses holding nothing are skipped; items missing
 *  the "hash" metadata are skipped with a warning (they cannot be keyed). */
export async function fetchOwned(api: AssetHubApi, addresses: string[]): Promise<OwnedNft[]> {
  const reads = await fetchOwnedAt(api, addresses)
  return reads.map((r) => r.item).filter((o): o is OwnedNft => o !== null)
}

