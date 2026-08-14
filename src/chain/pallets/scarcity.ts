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

import { Binary, Enum } from 'polkadot-api'
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

/** One `metadata_batch` result: every metadata pair of all three layers,
 *  as `[key, value]` byte pairs. A missing target resolves to empty
 *  layers, never an error. */
type MetadataLayers = Extract<
  Awaited<ReturnType<AssetHubApi['apis']['ScarcityApi']['metadata_batch']>>,
  { success: true }
>['value'][number]

// Runtime cap on queries per metadata_batch call — an oversized request
// fails TooLarge outright rather than truncating, so chunk below it.
const METADATA_BATCH_LIMIT = 128

/** All metadata of MANY instances in ONE runtime call (chunked at the
 *  runtime's cap, chunks in parallel): `ScarcityApi.metadata_batch`
 *  returns every pair of all three layers per query, positionally —
 *  out[i] answers instances[i]. Replaces the former per-tier getValues
 *  walk (≤9 storage round trips). */
async function batchInstanceMetadata(
  api: AssetHubApi,
  instances: bigint[]
): Promise<MetadataLayers[]> {
  const chunks: bigint[][] = []
  for (let i = 0; i < instances.length; i += METADATA_BATCH_LIMIT) {
    chunks.push(instances.slice(i, i + METADATA_BATCH_LIMIT))
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      api.apis.ScarcityApi.metadata_batch(chunk.map((i) => Enum('Instance', i)), AT)
    )
  )
  return results.flatMap((result) => {
    if (!result.success) throw new Error('metadata_batch refused the query batch')
    return result.value
  })
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Effective value for `key`, resolved instance -> item -> collection,
 *  most specific wins (mirrors the pallet's `instance_metadata_of`). */
function layeredValueOf(layers: MetadataLayers, key: Uint8Array): Uint8Array | undefined {
  for (const tier of [layers.instance, layers.item, layers.collection]) {
    for (const [k, v] of tier) if (bytesEq(k, key)) return v
  }
  return undefined
}

/** Display-metadata keys resolved alongside the identity hash, as the
 *  bytes metadata pairs are keyed by. */
const HASH_KEY = new TextEncoder().encode(HASH_METADATA_KEY)
const NAME_KEY = new TextEncoder().encode('name')
const IMAGE_KEY = new TextEncoder().encode('image')

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
 *  All metadata (hash, name, image — every key of every layer) arrives in
 *  ONE metadata_batch call, independent of the item count. Nothing is
 *  cached across polls: key-value metadata is mutable (the pallet has no
 *  freeze), so the design's rule is refresh-on-access — an item minted
 *  without the "hash" identity key (every pallet claim — empty metadata,
 *  READ_PATH.md) keys as `instance-<id>` this poll but picks up a hash
 *  written later (tooling backfill) without a reload. */
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

  const layers = await batchInstanceMetadata(api, present.map((p) => p.nft.instance))
  present.forEach((p, k) => {
    const found = layers[k]
    const hashBytes = found && layeredValueOf(found, HASH_KEY)
    const hash = hashBytes ? Binary.toHex(hashBytes) : `instance-${p.nft.instance}`
    const item: OwnedNft = { hash, mintedAt: Number(p.nft.minted_at) }
    const name = found && layeredValueOf(found, NAME_KEY)
    if (name) item.name = Binary.toText(name)
    const image = found && layeredValueOf(found, IMAGE_KEY)
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

