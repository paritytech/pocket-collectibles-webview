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
import type { OwnedNft } from '../../collection/types'
import type { AssetHubApi } from '../client'
import type { PurseSource } from '../purses'
import { normalizeHash } from '../../lib/hash'

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
export type MetadataLayers = Extract<
  Awaited<ReturnType<AssetHubApi['apis']['ScarcityApi']['metadata_batch']>>,
  { success: true }
>['value'][number]

/** One `metadata_batch` query: an `Instance`, an `{collection, item}` Item,
 *  or a bare `Collection` id — the mint-flow preview resolves item and
 *  collection metadata BEFORE anything is minted (pallets/preview.ts,
 *  pallets/minters.ts), so the batch is no longer instance-only. */
export type MetadataQuery = Parameters<
  AssetHubApi['apis']['ScarcityApi']['metadata_batch']
>[0][number]

// Runtime cap on queries per metadata_batch call — an oversized request
// fails TooLarge outright rather than truncating, so chunk below it.
const METADATA_BATCH_LIMIT = 128

/** All metadata of MANY targets in ONE runtime call (chunked at the
 *  runtime's cap, chunks in parallel): `ScarcityApi.metadata_batch`
 *  returns every pair of all three layers per query, positionally —
 *  out[i] answers queries[i]. Replaces the former per-tier getValues
 *  walk (≤9 storage round trips). Queries mix freely (Instance / Item /
 *  Collection). */
export async function metadataBatch(
  api: AssetHubApi,
  queries: MetadataQuery[]
): Promise<MetadataLayers[]> {
  const chunks: MetadataQuery[][] = []
  for (let i = 0; i < queries.length; i += METADATA_BATCH_LIMIT) {
    chunks.push(queries.slice(i, i + METADATA_BATCH_LIMIT))
  }
  const results = await Promise.all(
    chunks.map((chunk) => api.apis.ScarcityApi.metadata_batch(chunk, AT))
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
 *  most specific wins (mirrors the pallet's `instance_metadata_of`). An
 *  Item or Collection query simply has an empty `instance` tier, so the
 *  same resolution serves the mint-flow preview. */
export function layeredValueOf(layers: MetadataLayers, key: Uint8Array): Uint8Array | undefined {
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

/** The display name and artwork URL carried by a set of metadata layers,
 *  most-specific tier winning (see layeredValueOf). Shared by the owned
 *  read and the mint-flow preview so both resolve names/images the same
 *  way — an unset key yields undefined, a non-fetchable image yields no
 *  URL. */
export function resolveDisplay(layers: MetadataLayers): { name?: string; imageUrl?: string } {
  const out: { name?: string; imageUrl?: string } = {}
  const name = layeredValueOf(layers, NAME_KEY)
  if (name) out.name = Binary.toText(name)
  const image = layeredValueOf(layers, IMAGE_KEY)
  if (image) {
    const url = imageUrlOf(Binary.toText(image))
    if (url) out.imageUrl = url
  }
  return out
}

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
 *  "hash" identity metadata is occupied with item null). `nft` carries the
 *  raw on-chain identity of an occupied purse — the permanent instance and
 *  its ownership-state nonce — which a transfer needs to authorize the
 *  purse-key origin (the `AsScarcity` extension, chain/start.ts). */
export interface PurseRead {
  occupied: boolean
  item: OwnedNft | null
  nft?: { instance: bigint; stateNonce: bigint }
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

  const layers = await metadataBatch(api, present.map((p) => Enum('Instance', p.nft.instance)))
  present.forEach((p, k) => {
    const found = layers[k]
    const hashBytes = found && layeredValueOf(found, HASH_KEY)
    const hash = hashBytes ? Binary.toHex(hashBytes) : `instance-${p.nft.instance}`
    const item: OwnedNft = { hash, mintedAt: Number(p.nft.minted_at) }
    if (found) Object.assign(item, resolveDisplay(found))
    reads[p.pos] = {
      occupied: true,
      item,
      nft: { instance: p.nft.instance, stateNonce: p.nft.state_nonce }
    }
  })
  return reads
}

// ---- purse-index lookups (the write flows) ---------------------------------
// The mint claim and the send transfer both need a specific purse ADDRESS by
// its role, not the whole shelf: a claim mints into the first EMPTY purse, a
// transfer signs as the purse HOLDING a given item and sends into the
// recipient's first empty purse. Both walk a PurseSource low-index-first, the
// same layout the shelf scan reads, batching to keep the round trips down.

/** One located purse: its derivation index and SS58 address. */
export interface PurseLocation {
  index: number
  address: string
}

/** A located purse that HOLDS an item, carrying the raw NFT identity a
 *  transfer must echo back to authorize the purse-key origin. */
export interface HeldPurse extends PurseLocation {
  instance: bigint
  stateNonce: bigint
}

// Claims/transfers land low-index-first, so a free (or occupied) key is
// almost always in the first batch; the ceiling just bounds a pathological
// walk. Matches start.ts' scan bounds.
const PURSE_SCAN_BATCH = 10
const PURSE_SCAN_MAX = 1_000

/** The first EMPTY purse of `source`'s subtree — a mint/transfer target
 *  (`Scarcity` allows one NFT per key, so a destination must be free). */
export async function firstFreePurse(api: AssetHubApi, source: PurseSource): Promise<PurseLocation> {
  for (let start = 0; start < PURSE_SCAN_MAX; start += PURSE_SCAN_BATCH) {
    const indexes = Array.from({ length: PURSE_SCAN_BATCH }, (_, k) => start + k)
    const addresses = await Promise.all(indexes.map((i) => source.addressAt(i)))
    const reads = await fetchOwnedAt(api, addresses)
    const free = reads.findIndex((r) => !r.occupied)
    if (free >= 0) return { index: indexes[free], address: addresses[free] }
  }
  throw new Error(`no empty purse in the first ${PURSE_SCAN_MAX} indexes`)
}

/** The purse of `source`'s subtree currently holding the item whose identity
 *  hash matches `hash` (any 0x/case form), or null when none does — the
 *  sending key for a transfer. Stops at the first fully-empty batch, exactly
 *  like the shelf scan, so a normal shelf resolves in one round. */
export async function findPurseHolding(
  api: AssetHubApi,
  source: PurseSource,
  hash: string
): Promise<HeldPurse | null> {
  const target = normalizeHash(hash)
  for (let start = 0; start < PURSE_SCAN_MAX; start += PURSE_SCAN_BATCH) {
    const indexes = Array.from({ length: PURSE_SCAN_BATCH }, (_, k) => start + k)
    const addresses = await Promise.all(indexes.map((i) => source.addressAt(i)))
    const reads = await fetchOwnedAt(api, addresses)
    for (let k = 0; k < reads.length; k++) {
      const { item, nft } = reads[k]
      if (item && nft && normalizeHash(item.hash) === target) {
        return { index: indexes[k], address: addresses[k], instance: nft.instance, stateNonce: nft.stateNonce }
      }
    }
    // Nothing occupied in this batch → past the last purse, item isn't here.
    if (reads.every((r) => !r.occupied)) break
  }
  return null
}

