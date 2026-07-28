// Mintable collections and their browsable item catalogs
// (CHOOSE-YOUR-ITEM model: a ticket entitles one mint of its rarity tier,
// the player picks the exact item from a collection's catalog).
//
// PRODUCTION: the list of collections comes over the bridge — native reads
// the claim pallet's registry — and each collection's catalog + display
// comes from its jollity_api module. ⚠ Player-chosen items are a NEW
// runtime requirement (the current claim pallet derives the item from the
// credit's entropy); see the note on BridgeRequest.request.mint.

import { entryAt, poolSize, type Rarity, type ResolvedCollectible } from './resolver'

export interface MintCollection {
  id: string
  label: string
  /** One-line flavor for the picker sheet. */
  blurb: string
  /** Seed for this collection's mock catalog slice — keeps each
   *  collection's offering distinct and deterministic. */
  salt: number
  /** Collection color as an "R G B" string. Tickets are SECRETIVE (product
   *  decision: the outcome stays hidden until minted), so their glow comes
   *  from the target collection, never from the item they'd become. */
  tint: string
}

export const MINT_COLLECTIONS: readonly MintCollection[] = [
  { id: 'aurora', label: 'Aurora', blurb: 'The canonical launch set', salt: 0x0000, tint: '134 146 255' },
  { id: 'meridian', label: 'Meridian', blurb: 'Bold reinterpretations', salt: 0x4d31, tint: '72 205 182' },
  { id: 'bazaar', label: 'Bazaar', blurb: 'Community remixes', salt: 0x9e07, tint: '236 173 82' }
]

/** Governance-approved default (PRD: the default set; later outranked by
 *  the user's favorite collections — UJ-7, not this round). */
export const DEFAULT_COLLECTION_ID = 'aurora'

export function getCollection(id: string): MintCollection {
  return MINT_COLLECTIONS.find((c) => c.id === id) ?? MINT_COLLECTIONS[0]!
}

/** One choosable item in a collection's catalog. `index` is the pool
 *  position carried in `request.mint` — the mock's stand-in for a real
 *  catalog item id from jollity_api. */
export interface CatalogItem {
  index: number
  resolved: ResolvedCollectible
}

/** The items a collection offers at a rarity tier — what the player picks
 *  from when minting a ticket (CHOOSE-YOUR-ITEM model).
 *
 *  MOCK: each collection shows a distinct, deterministic slice of the art
 *  catalogue's rarity pool, seeded by its salt. PRODUCTION: this list
 *  comes from the collection's jollity_api catalog (with live supply /
 *  already-minted-out information the runtime will need to expose once
 *  player choice lands on-chain). */
export function collectionCatalog(
  collectionId: string,
  rarity: Rarity,
  count = 18
): CatalogItem[] {
  const salt = getCollection(collectionId).salt
  const size = poolSize(rarity)
  if (size === 0) return []
  const seen = new Set<number>()
  const out: CatalogItem[] = []
  for (let i = 0; out.length < Math.min(count, size) && i < size; i++) {
    const index = (salt * 13 + i * 29) % size
    if (seen.has(index)) continue
    seen.add(index)
    out.push({ index, resolved: entryAt(rarity, index) })
  }
  return out
}
