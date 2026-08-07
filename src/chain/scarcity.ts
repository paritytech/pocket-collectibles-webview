// On-chain read path for pallet-scarcity (Asset Hub).
//
// Vendored from the scarcity-tools SDK read surface
// (gaming-retreat-2026/scarcity-tools/packages/sdk/src/{client,types}.ts,
// polkadot-api@2.2.2, unsafe/descriptorless API) and narrowed to reads —
// the webview never signs or submits. Keep the query shapes in sync with
// that SDK if the pallet evolves.
//
// Chain model (pallet-scarcity, "coinage"): `NftsByOwner: AccountId -> Nft`
// is a plain map — an account holds at most ONE NFT, so a player's
// collection is a set of purse addresses, one item each. The 32-byte hash
// the gallery keys art/rarity off is NOT part of the Nft value; by
// convention it lives in metadata under the key "hash", resolved
// instance -> item -> collection (most specific wins).

import { Binary } from 'polkadot-api'
import type { OwnedNft } from '../bridge/types'

/** Metadata key convention carrying the 32-byte identity hash. */
export const HASH_METADATA_KEY = 'hash'

// Reads resolve at "best" blocks: snappier than finality, and safe for a
// display-only shelf (a reorged read self-corrects on the next refresh).
const AT = { at: 'best' } as const

/** `Scarcity.NftsByOwner` value as decoded by the unsafe API
 *  (field names match the pallet's SCALE struct). */
interface RawNft {
  instance: bigint
  collection: number
  item: number
  minted_at: bigint
  last_moved: bigint
  state_nonce: bigint
}

/** Metadata storages wrap values as `MetadataEntry { value, deposit }`. */
interface RawMetadataEntry {
  value: Uint8Array
  deposit: bigint
}

// The unsafe API is untyped by design; this narrow interface is our whole
// contract with it, so a runtime rename shows up here and nowhere else.
interface StorageRead {
  getValue(...args: unknown[]): Promise<unknown>
  getValues(keys: unknown[][], options?: unknown): Promise<unknown[]>
}
export interface ScarcityApi {
  query: {
    Scarcity: {
      NftsByOwner: StorageRead
      InstanceMetadata: StorageRead
      ItemMetadata: StorageRead
      CollectionMetadata: StorageRead
    }
  }
}

/** Validate an unsafe-API result into a RawNft, or null. Field-checks the
 *  shape so a runtime upgrade that changes the struct degrades to "no
 *  items" (plus a warning) instead of NaN timestamps or a crash. */
function intoRawNft(v: unknown): RawNft | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (
    typeof o.instance !== 'bigint' ||
    typeof o.collection !== 'number' ||
    typeof o.item !== 'number' ||
    typeof o.minted_at !== 'bigint'
  ) {
    console.warn('[chain] NftsByOwner value has unexpected shape', v)
    return null
  }
  return o as unknown as RawNft
}

/** Effective metadata value for `key`, resolved instance -> item ->
 *  collection, first match wins (mirrors the pallet's
 *  `instance_metadata_of`). */
async function metadataOf(
  api: ScarcityApi,
  nft: RawNft,
  key: string
): Promise<Uint8Array | undefined> {
  const keyBytes = Binary.fromText(key)
  const reads: (() => Promise<unknown>)[] = [
    () => api.query.Scarcity.InstanceMetadata.getValue(nft.instance, keyBytes, AT),
    () => api.query.Scarcity.ItemMetadata.getValue(nft.collection, nft.item, keyBytes, AT),
    () => api.query.Scarcity.CollectionMetadata.getValue(nft.collection, keyBytes, AT)
  ]
  for (const read of reads) {
    const entry = (await read()) as RawMetadataEntry | undefined
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

// Where content-addressed artwork is served from. Dev choice mirroring
// the team's web-demo config; the production artwork origin is an open
// platform question (DEPENDENCIES.md #17).
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

/** Read the owned set for a list of purse addresses and map it into the
 *  gallery's bridge shape, resolving identity hash + display name +
 *  artwork per item. Addresses holding nothing are skipped; items missing
 *  the "hash" metadata are skipped with a warning (they cannot be keyed). */
export async function fetchOwned(api: ScarcityApi, addresses: string[]): Promise<OwnedNft[]> {
  if (addresses.length === 0) return []
  const raws = await api.query.Scarcity.NftsByOwner.getValues(
    addresses.map((a) => [a]),
    AT
  )
  const hits: RawNft[] = []
  for (const raw of raws) {
    if (raw === undefined || raw === null) continue // address holds no NFT
    const nft = intoRawNft(raw)
    if (nft) hits.push(nft)
  }
  const owned = await Promise.all(
    hits.map(async (nft): Promise<OwnedNft | null> => {
      let hash = hashCache.get(nft.instance)
      const reads = await Promise.all([
        hash ? Promise.resolve(undefined) : metadataOf(api, nft, HASH_METADATA_KEY),
        metadataOf(api, nft, NAME_METADATA_KEY),
        metadataOf(api, nft, IMAGE_METADATA_KEY)
      ])
      if (!hash) {
        const bytes = reads[0]
        if (!bytes) {
          console.warn(`[chain] instance ${nft.instance} has no "${HASH_METADATA_KEY}" metadata; skipped`)
          return null
        }
        hash = Binary.toHex(bytes)
        hashCache.set(nft.instance, hash)
      }
      const item: OwnedNft = { hash, mintedAt: Number(nft.minted_at) }
      if (reads[1]) item.name = Binary.toText(reads[1])
      if (reads[2]) {
        const url = imageUrlOf(Binary.toText(reads[2]))
        if (url) item.imageUrl = url
      }
      return item
    })
  )
  return owned.filter((o): o is OwnedNft => o !== null)
}
