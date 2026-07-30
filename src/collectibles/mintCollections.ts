// Mintable collections + favourites.
//
// MODEL: a ticket mints into a COLLECTION (the player's only choice) — the
// collection then determines which item the ticket becomes, deterministically
// from the credit hash (same hash + same collection → same item, forever).
// There is no per-item choice.
//
// PRODUCTION: the collection list comes over the bridge (native reads the
// claim pallet's registry of collections with a registered minting
// contract); each collection's art/derivation comes from its jollity_api
// module. Favourites are a client-side preference (later synced), and the
// top favourite is the default mint target — the one-click "Mint all"
// destination (PRD UJ-7).

import { entryAt, poolSize, type Rarity, type ResolvedCollectible } from './resolver'

export interface MintCollection {
  id: string
  label: string
  /** One-line flavor for the picker. */
  blurb: string
  /** Salt that makes each collection derive a DIFFERENT item from the same
   *  credit hash (the mock stand-in for distinct minting contracts). */
  salt: number
  /** Collection color as an "R G B" string — its identity on the picker
   *  and the sealed ticket (tickets stay secretive; the tint is the only
   *  pre-mint signal). */
  tint: string
}

// ~10 collections — the count the real registry is expected to carry, so
// the picker is designed to scroll through them comfortably.
export const MINT_COLLECTIONS: readonly MintCollection[] = [
  { id: 'aurora', label: 'Aurora', blurb: 'The canonical launch set', salt: 0x0000, tint: '134 146 255' },
  { id: 'meridian', label: 'Meridian', blurb: 'Bold reinterpretations', salt: 0x4d31, tint: '72 205 182' },
  { id: 'bazaar', label: 'Bazaar', blurb: 'Community remixes', salt: 0x9e07, tint: '236 173 82' },
  { id: 'ember', label: 'Ember', blurb: 'Warm, hand-painted', salt: 0x2c58, tint: '244 118 92' },
  { id: 'tidal', label: 'Tidal', blurb: 'Deep-sea palette', salt: 0x71a3, tint: '86 180 232' },
  { id: 'verdant', label: 'Verdant', blurb: 'Living, overgrown', salt: 0x5f2f, tint: '120 200 110' },
  { id: 'obsidian', label: 'Obsidian', blurb: 'Monochrome & stark', salt: 0x8b2f, tint: '176 176 196' },
  { id: 'blossom', label: 'Blossom', blurb: 'Soft floral tones', salt: 0xd36a, tint: '238 150 200' },
  { id: 'relic', label: 'Relic', blurb: 'Aged & antique', salt: 0xa47f, tint: '206 178 120' },
  { id: 'prism', label: 'Prism', blurb: 'Iridescent & bright', salt: 0x3e91, tint: '190 130 246' }
]

/** Governance-approved default — the fallback mint target when the player
 *  has no favourites yet. */
export const DEFAULT_COLLECTION_ID = 'aurora'

export function getCollection(id: string): MintCollection {
  return MINT_COLLECTIONS.find((c) => c.id === id) ?? MINT_COLLECTIONS[0]!
}

// ---- Favourites (client-side preference, persisted) -----------------------

const FAV_KEY = 'pkt_fav_collections_v1'

export function loadFavourites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    const ids = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(ids)) return []
    return ids.filter((id): id is string => typeof id === 'string' && MINT_COLLECTIONS.some((c) => c.id === id))
  } catch { return [] }
}

export function saveFavourites(ids: readonly string[]): void {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(ids)) } catch { /* private mode */ }
}

/** The default mint target: the first favourite, else the governance
 *  default. This is where one-click "Mint all" sends everything. */
export function defaultTarget(favourites: readonly string[]): string {
  return favourites[0] ?? DEFAULT_COLLECTION_ID
}

/** Collections ordered for the picker: favourites first (in fave order),
 *  then the rest in registry order. */
export function orderedCollections(favourites: readonly string[]): MintCollection[] {
  const favSet = new Set(favourites)
  const favs = favourites.map(getCollection)
  const rest = MINT_COLLECTIONS.filter((c) => !favSet.has(c.id))
  return [...favs, ...rest]
}

// ---- Deterministic collection → item --------------------------------------

/** Pool index a ticket resolves to in a collection: a stable function of
 *  (credit hash, collection salt) within the tier's pool. Same inputs →
 *  same item, forever; different collection → different item. */
export function outcomeIndex(hash: string, rarity: Rarity, collectionId: string): number {
  const h = (hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash).toLowerCase()
  const size = poolSize(rarity)
  if (size === 0) return 0
  const pick = parseInt(h.slice(4, 12) || '0', 16) || 0
  return (pick ^ getCollection(collectionId).salt) % size
}

/** The exact item a ticket becomes in a collection (used at mint time and
 *  in the reveal — NOT shown before minting; tickets stay secretive). */
export function outcomeFor(hash: string, rarity: Rarity, collectionId: string): ResolvedCollectible {
  return entryAt(rarity, outcomeIndex(hash, rarity, collectionId))
}
