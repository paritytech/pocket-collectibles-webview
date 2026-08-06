// Collectible hash → displayable asset.
//
// Ported from the CollectableHashResolver tool (~/git/CollectableHashResolver)
// and the game-results webview's src/attestations/resolver.ts. Images are
// hosted on the Web3 Summit IPFS gateway and indexed by CID in cid_map.json.
// The 32-byte NFT hash deterministically picks one image from the catalog:
//
//   bytes 0-1 → rarity roll (uint16; if < RARE_THRESHOLD → rare pool)
//   bytes 2-3 → image index (uint16; mod pool size → entry in the
//                lexicographically-sorted pool)
//
// The collection is split at module load into a "normal" pool and a
// "rare" pool by checking each filename for the substring "rare"
// (case-insensitive). Sorting is by full path key, lexicographic, so new
// images appended with later 5-digit prefixes never remap existing hashes.
//
// Unlike the game-results version this resolver is SYNCHRONOUS: the
// gallery resolves a whole owned set up front to lay out tiles, and the
// only async work (loading the IPFS image) happens in the <img> tag.

import cidMap from './cid_map.json'

+/** Paseo Bulletin Next IPFS gateway. Serves catalogue images at `/ipfs/<cid>`. */
+const IPFS_GATEWAY = 'https://paseo-bulletin-next-ipfs.polkadot.io/ipfs'

// Rarity-roll bands over the uint16 space (0..65535), read from bytes 0-1:
//   [0, RARE_THRESHOLD) → rare pool
//   else                → normal pool

/** Rare band width. 7865/65536 ≈ 12%. This is the historical sticker band
 *  [0, 1311) plus the historical rare band [1311, 7865): the Web3 Summit
 *  sticker tier was retired (see EVENT_EXCLUSIVES.md), and folding its band
 *  into rare is what the previous band logic already did when the sticker pool
 *  was empty — so every existing rare/common hash keeps its exact art, and
 *  former sticker-band hashes resolve as rares. Do NOT change this value:
 *  it would remap art on hashes users already own. */
const RARE_THRESHOLD = 7865

export type Rarity = 'common' | 'rare'

interface PoolEntry {
  url: string
  filename: string
  name: string
  collection: string
  /** 1-based position of this item within its collection (sorted), and the
   *  collection's total size — drives the "No. X of Y" detail fact. */
  collectionIndex: number
  collectionSize: number
  /** Per-item glow colour as an "R G B" string for `rgb(var(--glow) / a)`,
   *  derived from the swatch hex embedded in the catalogue filename. */
  glow: string
}

/** True per-item drop rate as a percentage. A hash first rolls INTO a pool
 *  (rare ≈ RARE_THRESHOLD/65536 ≈ 12%, common ≈ the rest), then picks
 *  uniformly among that pool's entries — so the chance of any ONE specific
 *  item is the pool-roll probability divided by the pool size, NOT the bare
 *  pool-roll chance. Pool sizes are read at call time, after indexCatalogue()
 *  has run at module load. */
export function dropRatePercent(rarity: Rarity): number {
  let bandProb: number
  let poolSize: number
  if (rarity === 'rare') {
    bandProb = RARE_THRESHOLD / 65536
    poolSize = RARE_KEYS.length
  } else {
    bandProb = 1 - RARE_THRESHOLD / 65536
    poolSize = NORMAL_KEYS.length
  }
  if (poolSize <= 0) return 0
  return (bandProb / poolSize) * 100
}

/** Display label for the detail "Drop rate" fact. Per-item rates sit well
 *  under 1%, so format with enough precision to stay meaningful rather than
 *  rounding everything to "0%": "<0.1%" for the vanishingly rare, one decimal
 *  below 10%, whole numbers above. */
export function dropRateLabel(rarity: Rarity): string {
  const pct = dropRatePercent(rarity)
  if (pct <= 0) return '—'
  if (pct < 0.1) return '<0.1%'
  if (pct < 10) return `~${pct.toFixed(1)}%`
  return `~${Math.round(pct)}%`
}

/** Title-case a separator-delimited fragment: "_"/"-" → spaces, collapse
 *  whitespace, capitalise each word. */
function titleCase(fragment: string): string {
  return fragment
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Fallback glow (a soft Polkadot-ish blue) for items with no/invalid hex,
 *  expressed as the "R G B" string the `--glow` CSS var expects. */
const DEFAULT_GLOW = '120 134 255'

/** Lift a colour toward a clean "glow" — boost saturation a touch and force a
 *  high value, since a glow is light rather than pigment. Mirrors the old
 *  runtime swatch extractor's `vivify` so the baked-hex glow reads the same as
 *  the per-pixel one it replaces; near-greyscale colours are left untinted. */
function vivify(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const d = max - min
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s2 = s > 0.18 ? Math.min(1, s * 1.35) : s
  const v2 = Math.max(max, 0.92)
  const c = v2 * s2
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v2 - c
  let rr = 0, gg = 0, bb = 0
  if (h < 60) [rr, gg, bb] = [c, x, 0]
  else if (h < 120) [rr, gg, bb] = [x, c, 0]
  else if (h < 180) [rr, gg, bb] = [0, c, x]
  else if (h < 240) [rr, gg, bb] = [0, x, c]
  else if (h < 300) [rr, gg, bb] = [x, 0, c]
  else [rr, gg, bb] = [c, 0, x]
  return [Math.round((rr + m) * 255), Math.round((gg + m) * 255), Math.round((bb + m) * 255)]
}

/** Convert a 6-char hex colour ("8F5E4F") to the vivified "R G B" component
 *  string used by `rgb(var(--glow) / a)`. Returns the fallback on malformed
 *  input. */
function hexToGlow(hex: string): string {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return DEFAULT_GLOW
  const n = parseInt(hex, 16)
  const [r, g, b] = vivify((n >> 16) & 255, (n >> 8) & 255, n & 255)
  return `${r} ${g} ${b}`
}

/** Split a catalogue filename into its collection, display name, and the
 *  embedded swatch hex. The catalogue key format is
 *    "INDEX--Category--name--tag--HEX.webp"
 *  e.g. "00120--Animals--red_panda--Rare--C24A2F.webp" →
 *       { collection: "Animals", name: "Red Panda", hex: "C24A2F" }
 *  The leading index, the rarity/tag segment (second-to-last), and the hex
 *  (last) are all dropped from the name; underscores within the name become
 *  spaces. A filename that doesn't fit the `--` shape falls back to treating
 *  the whole basename as the name with no collection or hex. */
function parseFilename(filename: string): { collection: string; name: string; hex: string } {
  const base = filename.replace(/\.[a-z0-9]+$/i, '')   // drop extension
  const parts = base.split('--')
  if (parts.length < 4) {
    return { collection: '', name: titleCase(base.replace(/^\d+[_-]/, '')), hex: '' }
  }
  const collection = titleCase(parts[1] ?? '')
  const hexRaw = (parts[parts.length - 1] ?? '').trim()
  const hex = /^[0-9a-fA-F]{6}$/.test(hexRaw) ? hexRaw : ''
  // Name is everything between the category (index 1) and the trailing
  // tag + hex (the last two segments).
  const name = titleCase(parts.slice(2, parts.length - 2).join(' '))
  return { collection, name: name || collection, hex }
}

/** Just the collection token of a filename (the second `--` segment, after
 *  the numeric index) — a lighter path than `parseFilename` for the load-time
 *  grouping pass, which only needs to bucket every catalogue key by
 *  collection. */
function collectionOf(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, '')
  const parts = base.split('--')
  return titleCase(parts.length >= 2 ? parts[1]! : (parts[0] ?? ''))
}

const MAP = cidMap as Record<string, string>

/** Index the catalogue once at module load into two pools of *map keys*
 *  (lexicographically sorted): rare (filenames containing "rare") and
 *  everything else (normal). Entries whose CID is missing/empty are skipped so
 *  the pool sizes match exactly. This does only the cheap classification — no
 *  URL strings, no display-name regexes, no per-entry objects — so the
 *  hash→image mapping stays byte-for-byte identical to the game-results
 *  resolver while the heavy materialization is deferred to `materialize()`.
 *
 *  Why: the mapping needs the full ordered/classified catalogue (a hash
 *  picks `pickVal % pool.length` over the sorted pool, so dropping entries
 *  would remap every hash). But a CID is only ever *used* for an entry the
 *  user actually owns. With the catalogue at thousands of entries, eagerly
 *  building a URL + running the 6-regex name transform for all of them at
 *  startup was O(catalogue) wasted main-thread work before first paint;
 *  now it's O(owned). */
function indexCatalogue(): {
  normal: string[]
  rare: string[]
  place: Map<string, { index: number; size: number }>
} {
  const normal: string[] = []
  const rare: string[] = []
  // collection → its keys in sorted order, for "No. X of Y" placement.
  const byCollection = new Map<string, string[]>()
  for (const key of Object.keys(MAP).sort()) {
    const cid = MAP[key]
    if (typeof cid !== 'string' || !cid) continue
    const filename = key.replace(/\\/g, '/').split('/').pop() || key
    if (filename.toLowerCase().includes('rare')) rare.push(key)
    else normal.push(key)
    const collection = collectionOf(filename)
    const members = byCollection.get(collection)
    if (members) members.push(key)
    else byCollection.set(collection, [key])
  }
  const place = new Map<string, { index: number; size: number }>()
  for (const members of byCollection.values()) {
    members.forEach((k, i) => place.set(k, { index: i + 1, size: members.length }))
  }
  return { normal, rare, place }
}

const { normal: NORMAL_KEYS, rare: RARE_KEYS, place: COLLECTION_PLACE } = indexCatalogue()

/** Total number of distinct images in the catalogue (normal + rare). */
export const CATALOGUE_SIZE = NORMAL_KEYS.length + RARE_KEYS.length

/** Lazily turn a catalogue key into a displayable PoolEntry, memoized so a
 *  repeated resolve (a popular image, a re-render, or the malformed-hash
 *  fallback) never rebuilds the URL/name. Only ever called for entries the
 *  user owns. */
const entryCache = new Map<string, PoolEntry>()
function materialize(key: string): PoolEntry {
  let entry = entryCache.get(key)
  if (entry) return entry
  const filename = key.replace(/\\/g, '/').split('/').pop() || key
  const { collection, name, hex } = parseFilename(filename)
  const place = COLLECTION_PLACE.get(key) ?? { index: 0, size: 0 }
  entry = {
    url: `${IPFS_GATEWAY}/${MAP[key]}`,
    filename,
    name,
    collection,
    collectionIndex: place.index,
    collectionSize: place.size,
    glow: hexToGlow(hex)
  }
  entryCache.set(key, entry)
  return entry
}

export interface ResolvedCollectible {
  /** IPFS gateway URL — ready to drop into an <img src>. */
  url: string
  /** Original filename from cid_map (e.g. "00003_Black_Opal_rare.png"). */
  filename: string
  /** Human display name with the collection prefix removed, e.g. the
   *  "Aperol Spritz" of "00001_Cocktail_Aperol_Spritz.png". */
  name: string
  /** Collection the item belongs to — the first filename segment, e.g.
   *  "Cocktail". Empty for single-segment filenames. */
  collection: string
  /** 1-based position of this item within its collection, and the
   *  collection's total size — for the "No. X of Y" detail fact. Both 0 if
   *  the item's collection couldn't be placed. */
  collectionIndex: number
  collectionSize: number
  /** Tier derived from the hash's rarity roll: 'rare' or 'common'. */
  rarity: Rarity
  /** Convenience alias for `rarity === 'rare'`. */
  isRare: boolean
  /** Per-item glow colour as an "R G B" string (e.g. "143 94 79"), taken from
   *  the swatch hex baked into the catalogue filename. Feeds the `--glow` CSS
   *  var so each collectible's halo matches its dominant colour. */
  glow: string
}

/** Parse a uint16 from two consecutive bytes at the given byte offset. */
function uint16At(hex: string, byteOffset: number): number {
  const start = byteOffset * 2
  const hi = parseInt(hex.slice(start, start + 2), 16)
  const lo = parseInt(hex.slice(start + 2, start + 4), 16)
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return 0
  return ((hi & 0xff) << 8) | (lo & 0xff)
}

/** Resolve a 32-byte NFT hash to a catalogue image.
 *
 *  Accepts hex with or without a leading "0x", case-insensitive. On
 *  malformed input, falls back to the first available entry and logs a
 *  warning (one bad hash never empties the gallery). */
export function resolveCollectible(hashHex: string): ResolvedCollectible {
  const cleaned = (hashHex || '').trim()
  const hex = cleaned.startsWith('0x') || cleaned.startsWith('0X')
    ? cleaned.slice(2)
    : cleaned

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const fallbackKey = NORMAL_KEYS[0] ?? RARE_KEYS[0]
    if (!fallbackKey) throw new Error('cid_map is empty')
    console.warn(
      `[resolver] hash not 32-byte hex (got ${hex.length} chars), using fallback`,
      hashHex.slice(0, 16)
    )
    return { ...materialize(fallbackKey), rarity: 'common', isRare: false }
  }

  const rarityVal = uint16At(hex, 0)
  const pickVal = uint16At(hex, 2)

  // A pool that's empty falls through to the next tier so one lopsided
  // catalogue never crashes resolution.
  let pool: string[]
  let rarity: Rarity
  if (RARE_KEYS.length > 0 && rarityVal < RARE_THRESHOLD) {
    pool = RARE_KEYS
    rarity = 'rare'
  } else {
    pool = NORMAL_KEYS
    rarity = 'common'
  }
  if (pool.length === 0) throw new Error('collectible pools are empty')

  const entry = materialize(pool[pickVal % pool.length]!)
  return { ...entry, rarity, isRare: rarity === 'rare' }
}
