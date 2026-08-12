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

/** Effective metadata value for `key`, resolved instance -> item ->
 *  collection, first match wins (mirrors the pallet's
 *  `instance_metadata_of`). Metadata keys/values are `Vec<u8>`, which the
 *  typed api serves as bytes. */
async function metadataOf(
  api: AssetHubApi,
  nft: Nft,
  key: string
): Promise<Uint8Array | undefined> {
  const keyBytes = Binary.fromText(key)
  const reads = [
    () => api.query.Scarcity.InstanceMetadata.getValue(nft.instance, keyBytes, AT),
    () => api.query.Scarcity.ItemMetadata.getValue(nft.collection, nft.item, keyBytes, AT),
    () => api.query.Scarcity.CollectionMetadata.getValue(nft.collection, keyBytes, AT)
  ]
  for (const read of reads) {
    const entry = await read()
    if (entry && entry.value instanceof Uint8Array) return entry.value
  }
  return undefined
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
 *  scan (chain/start.ts) needs per-index occupancy, not just the items. */
export async function fetchOwnedAt(api: AssetHubApi, addresses: string[]): Promise<PurseRead[]> {
  if (addresses.length === 0) return []
  const raws = await api.query.Scarcity.NftsByOwner.getValues(
    addresses.map((a) => [a] as [string]),
    AT
  )
  return Promise.all(
    raws.map(async (raw): Promise<PurseRead> => {
      if (raw === undefined || raw === null) return { occupied: false, item: null }
      const nft = raw as Nft
      let hash = hashCache.get(nft.instance)
      const reads = await Promise.all([
        hash ? Promise.resolve(undefined) : metadataOf(api, nft, HASH_METADATA_KEY),
        metadataOf(api, nft, NAME_METADATA_KEY),
        metadataOf(api, nft, IMAGE_METADATA_KEY)
      ])
      if (!hash) {
        const bytes = reads[0]
        if (bytes) {
          hash = Binary.toHex(bytes)
        } else {
          // No identity hash at any tier — the signature of a
          // pallet-claimed item (the claim mints with empty metadata,
          // READ_PATH.md; every tooling mint writes the hash). The item
          // is real and owned: key it by its instance id — unique,
          // stable, impossible to confuse with a 32-byte credit hash.
          hash = `instance-${nft.instance}`
        }
        hashCache.set(nft.instance, hash)
      }
      const item: OwnedNft = { hash, mintedAt: Number(nft.minted_at) }
      if (reads[1]) item.name = Binary.toText(reads[1])
      if (reads[2]) {
        const url = imageUrlOf(Binary.toText(reads[2]))
        if (url) item.imageUrl = url
      }
      return { occupied: true, item }
    })
  )
}

/** Read the owned set for a list of purse addresses and map it into the
 *  gallery's bridge shape, resolving identity hash + display name +
 *  artwork per item. Addresses holding nothing are skipped; items missing
 *  the "hash" metadata are skipped with a warning (they cannot be keyed). */
export async function fetchOwned(api: AssetHubApi, addresses: string[]): Promise<OwnedNft[]> {
  const reads = await fetchOwnedAt(api, addresses)
  return reads.map((r) => r.item).filter((o): o is OwnedNft => o !== null)
}

