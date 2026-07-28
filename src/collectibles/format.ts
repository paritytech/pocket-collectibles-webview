// View-model helpers: turn raw OwnedNft data into the shape the gallery
// renders, plus hash/date formatting and sorting.

import type { OwnedNft } from '../bridge/types'
import { resolveCollectible, type ResolvedCollectible } from './resolver'
import { getCollection } from './mintCollections'

/** A fully-resolved collectible ready for the UI. Each owned hash is unique,
 *  but distinct hashes often resolve to the SAME art — the gallery collapses
 *  those into one representative tile carrying a `count` (see
 *  collapseDuplicates), shown as a small "×N" badge. */
export interface CollectibleEntry {
  /** Normalized hash (lowercase, no 0x) — the React key + dedup id. */
  hash: string
  /** 0x-prefixed hash for display / copy. */
  hashHex: string
  /** Short friendly code for the tile, e.g. "7F3A·9C2B". */
  shortCode: string
  /** Unix-seconds mint time, if known. */
  mintedAt?: number
  /** True for staged candidates not yet finalised on-chain. */
  pending: boolean
  /** Resolved art + rarity + name. */
  resolved: ResolvedCollectible
  /** Registry id of the mint collection this item belongs to (bridge v2).
   *  Absent on legacy v1 payloads. */
  collectionId?: string
  /** Display label for the mint collection — the registry label when
   *  known, else the art catalogue's internal category. */
  collectionLabel: string
  /** Set when the item can't be transferred right now; the reason is shown
   *  to the player verbatim. */
  transferBlocked?: { reason: string }
  /** The game this item is playable in (UJ-6). */
  gameLink?: { label: string; url: string }
  /** Number of owned items that resolve to this same asset (≥1). Set by
   *  collapseDuplicates; a value > 1 renders a "×N" badge on the tile. */
  count?: number
}

function strip0x(hash: string): string {
  return hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash
}

/** Truncated hash for inline display: "a3f1c0…9c2b". */
export function shortHash(hash: string): string {
  const h = strip0x(hash)
  if (h.length <= 12) return h
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}

/** Compact, distinctive code for a tile badge: two 4-char groups from the
 *  head + tail of the hash, uppercased. Stable per hash, reads like a
 *  serial number ("7F3A·9C2B"). */
export function shortCode(hash: string): string {
  const h = strip0x(hash).toUpperCase()
  if (h.length < 8) return h
  return `${h.slice(0, 4)}·${h.slice(-4)}`
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric', month: 'short', year: 'numeric'
})

/** Absolute mint date, e.g. "27 May 2026". Falls back to "Pending" for a
 *  missing or out-of-range value rather than rendering "Invalid Date". */
export function formatMintDate(mintedAt: number | undefined): string {
  if (!mintedAt) return 'Pending'
  const d = new Date(mintedAt * 1000)
  return Number.isNaN(d.getTime()) ? 'Pending' : DATE_FMT.format(d)
}

/** Relative mint time, e.g. "2d ago", "just now". `now` is injectable
 *  for testing. */
export function formatRelative(mintedAt: number | undefined, now: number = Date.now()): string {
  if (!mintedAt) return 'pending'
  const diffMs = now - mintedAt * 1000
  const sec = Math.max(0, Math.floor(diffMs / 1000))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(day / 365)}y ago`
}

/** Resolve one OwnedNft into a CollectibleEntry. */
export function buildEntry(nft: OwnedNft): CollectibleEntry {
  const hash = strip0x(nft.hash).toLowerCase()
  const hashHex = `0x${hash}`
  const resolved = resolveCollectible(nft.hash)
  const entry: CollectibleEntry = {
    hash,
    hashHex,
    shortCode: shortCode(hash),
    pending: nft.pending === true,
    resolved,
    collectionLabel: nft.collectionId ? getCollection(nft.collectionId).label : resolved.collection
  }
  if (typeof nft.mintedAt === 'number') entry.mintedAt = nft.mintedAt
  if (typeof nft.collectionId === 'string') entry.collectionId = nft.collectionId
  if (nft.transferBlocked && typeof nft.transferBlocked.reason === 'string') {
    entry.transferBlocked = { reason: nft.transferBlocked.reason }
  }
  if (nft.gameLink) entry.gameLink = { ...nft.gameLink }
  return entry
}

/** Build all gallery entries from the owned set. */
export function buildEntries(nfts: OwnedNft[]): CollectibleEntry[] {
  return nfts.map(buildEntry)
}

/** Collapse entries that resolve to the same asset into one representative
 *  carrying a `count`. The representative is the most-recently-minted member,
 *  so "Newest" sort reflects the latest copy. Pending and confirmed copies of
 *  the same art stay separate (they're distinct states). Input is not mutated.
 *  Insertion order of first-seen assets is preserved (sortEntries reorders). */
export function collapseDuplicates(entries: CollectibleEntry[]): CollectibleEntry[] {
  const groups = new Map<string, { rep: CollectibleEntry; count: number }>()
  for (const e of entries) {
    // Same art in a DIFFERENT mint collection is a different item.
    const key = `${e.resolved.url}|${e.pending ? 'p' : 'o'}|${e.collectionId ?? ''}`
    const g = groups.get(key)
    if (!g) { groups.set(key, { rep: e, count: 1 }); continue }
    g.count += 1
    if ((e.mintedAt ?? 0) > (g.rep.mintedAt ?? 0)) g.rep = e
  }
  return Array.from(groups.values(), ({ rep, count }) => ({ ...rep, count }))
}

export type SortMode = 'recent' | 'rarity' | 'name' | 'collection'

export const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Newest',
  rarity: 'Rarity',
  name: 'Name',
  collection: 'Collection'
}

/** Case-insensitive match against the fields a player thinks in: item
 *  name and collection label. */
export function matchesQuery(entry: CollectibleEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    entry.resolved.name.toLowerCase().includes(q) ||
    entry.collectionLabel.toLowerCase().includes(q)
  )
}

/** Sort a list of entries by the chosen mode. Returns a new array; never
 *  mutates the input. Ties break on hash for a stable, deterministic order
 *  regardless of native delivery order. */
export function sortEntries(entries: CollectibleEntry[], mode: SortMode): CollectibleEntry[] {
  const out = entries.slice()
  out.sort((a, b) => {
    switch (mode) {
      case 'recent': {
        // Pending (no timestamp) sort to the very top — they're the
        // freshest activity the user should notice.
        const am = a.mintedAt ?? Infinity
        const bm = b.mintedAt ?? Infinity
        if (am !== bm) return bm - am
        break
      }
      case 'rarity': {
        // Rare above common; newest within a tier.
        const ta = a.resolved.isRare ? 1 : 0
        const tb = b.resolved.isRare ? 1 : 0
        if (ta !== tb) return tb - ta
        const am = a.mintedAt ?? 0
        const bm = b.mintedAt ?? 0
        if (am !== bm) return bm - am
        break
      }
      case 'name': {
        const cmp = a.resolved.name.localeCompare(b.resolved.name)
        if (cmp !== 0) return cmp
        break
      }
      case 'collection': {
        // Group by mint collection (falls back to the art category for
        // legacy items), names A→Z within a group.
        const cmp = a.collectionLabel.localeCompare(b.collectionLabel)
        if (cmp !== 0) return cmp
        const byName = a.resolved.name.localeCompare(b.resolved.name)
        if (byName !== 0) return byName
        break
      }
    }
    return a.hash.localeCompare(b.hash)
  })
  return out
}
