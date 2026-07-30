// Mock CollectionInput shapes used by the ?dev=1 panel. Each variant
// exercises a distinct gallery state. In production, native delivers the
// real owned set via window.setCollection / window.pushNft.

import type { CollectionInput, OwnedNft, Ticket } from './bridge/types'
import { MOCK_FAIL_SUFFIX } from './mock/mockNative'
import { RARE_THRESHOLD, poolSize, type Rarity } from './collectibles/resolver'

/** A realistic native-shape NFT hash: 64 lowercase hex chars (32 bytes).
 *  The resolver consumes the first 4 bytes for rarity + image pick, so a
 *  plain random hash is all we need. */
function randomHash(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let h = '0x'
  for (let i = 0; i < bytes.length; i++) h += bytes[i]!.toString(16).padStart(2, '0')
  return h
}

/** Set the rarity roll (bytes 0-1, big-endian uint16) on a fresh random hash
 *  so it lands in a chosen band: rare [0, 7865), common otherwise (see
 *  RARE_THRESHOLD in resolver.ts). */
function hashWithRarityRoll(min: number, max: number): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const v = min + Math.floor(Math.random() * (max - min))
  bytes[0] = (v >> 8) & 0xff
  bytes[1] = v & 0xff
  let h = '0x'
  for (let i = 0; i < bytes.length; i++) h += bytes[i]!.toString(16).padStart(2, '0')
  return h
}

/** A hash forced into the rare pool: rarity roll in [0, RARE_THRESHOLD). */
function rareHash(): string {
  return hashWithRarityRoll(0, 7865)
}

/** `n` DISTINCT hashes that all resolve to the SAME asset: the resolver keys
 *  off bytes 0-3 (rarity roll + image pick), so sharing those four bytes while
 *  randomising the rest yields duplicates of one collectible. Used to exercise
 *  the "×N" duplicate badge. */
function dupes(n: number): OwnedNft[] {
  const head = new Uint8Array(4)
  crypto.getRandomValues(head)
  const now = Math.floor(Date.now() / 1000)
  const out: OwnedNft[] = []
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    bytes.set(head, 0)
    let h = '0x'
    for (let j = 0; j < bytes.length; j++) h += bytes[j]!.toString(16).padStart(2, '0')
    out.push({ hash: h, mintedAt: now - i * 3600 })
  }
  return out
}

const DAY = 86_400 // seconds

/** Build `count` owned NFTs spread across recent "games" of ~10 items each.
 *  Every item in a game shares ONE exact `mintedAt`, mirroring production —
 *  a game's NFTs are minted together, so they carry the same on-chain
 *  per-game timestamp (per the bridge contract). */
function buildOwned(count: number, rareEvery: number = 7): OwnedNft[] {
  const now = Math.floor(Date.now() / 1000)
  // Most items were minted into the default collection, a few elsewhere —
  // exercises collection labels + the Collection sort. Collections map to
  // games (PRD: game-linked collections; the jollity_api game-link field):
  // Meridian is Top Trumps' set, Bazaar belongs to Exploding Kitties.
  const collections = ['aurora', 'aurora', 'meridian', 'bazaar']
  const gameFor: Record<string, { label: string; url: string } | undefined> = {
    meridian: { label: 'Top Trumps', url: 'game://top-trumps/deck' },
    bazaar: { label: 'Exploding Kitties', url: 'game://exploding-kitties/hand' }
  }
  const out: OwnedNft[] = []
  for (let i = 0; i < count; i++) {
    const game = Math.floor(i / 10)
    const mintedAt = now - game * 3 * DAY // SAME for every item in the game
    const isRare = rareEvery > 0 && i % rareEvery === rareEvery - 1
    const collectionId = collections[i % collections.length]!
    const link = gameFor[collectionId]
    out.push({
      hash: isRare ? rareHash() : randomHash(),
      mintedAt,
      collectionId,
      ...(link ? { gameLink: link } : {})
    })
  }
  return out
}

// ---- Ticket builders (bridge v2 scenarios) --------------------------------

interface TicketOpts {
  state?: Ticket['state']
  /** Seconds from now until the retention window ends. */
  expiresIn?: number
  hash?: string
}

function ticket(opts: TicketOpts = {}): Ticket {
  const t: Ticket = {
    hash: opts.hash ?? randomHash(),
    state: opts.state ?? 'mintable'
  }
  if (opts.expiresIn !== undefined) {
    t.expiresAt = Math.floor(Date.now() / 1000) + opts.expiresIn
  }
  return t
}

/** A ticket whose mint will FAIL: the mock native rejects any hash ending
 *  with MOCK_FAIL_SUFFIX (its stand-in for a stale proof / dropped tx).
 *  Exercises the "failed mint keeps its credit, batch continues" path. */
function failingTicket(opts: TicketOpts = {}): Ticket {
  const base = randomHash()
  return ticket({ ...opts, hash: base.slice(0, base.length - MOCK_FAIL_SUFFIX.length) + MOCK_FAIL_SUFFIX })
}

/** A ticket that previews (and mints) as a rare. */
function rareTicket(opts: TicketOpts = {}): Ticket {
  return ticket({ ...opts, hash: rareHash() })
}

// Realistic People Chain handles — lowercase, with a numeric suffix, ~11
// chars. Most usernames cluster around this length, so the header is tuned
// to display them comfortably.
const MOCK_NAME = 'byteboro.42'

// ---- Composable scenario axes ---------------------------------------------
// The dev panel composes a state from three independent axes instead of
// maintaining every combination as a named scenario: WHAT'S ON THE SHELF ×
// HOW MUCH IS COLLECTED × collection flavors. The ?mock= names below remain
// as aliases onto these axes.

export const TICKET_SETS = {
  none: { label: 'none', build: (): Ticket[] => [] },
  fresh: {
    label: 'post-game',
    build: (): Ticket[] => [
      rareTicket({ expiresIn: 3 * DAY }),
      ticket({ expiresIn: 4 * DAY }),
      ticket({ expiresIn: 4 * DAY }),
      ticket({ state: 'finalizing', expiresIn: 6 * DAY }),
      ticket({ state: 'finalizing', expiresIn: 6 * DAY })
    ]
  },
  expiring: {
    label: 'expiring',
    build: (): Ticket[] => [
      ticket({ expiresIn: 45 * 60 }),
      ticket({ expiresIn: 20 * 3600 }),
      rareTicket({ expiresIn: 5 * DAY }),
      ticket({ expiresIn: -2 * 3600 })
    ]
  },
  finalizing: {
    label: 'finalizing',
    build: (): Ticket[] => [
      ticket({ state: 'finalizing', expiresIn: 6 * DAY }),
      rareTicket({ expiresIn: 6 * DAY, state: 'finalizing' }),
      ticket({ state: 'finalizing', expiresIn: 6 * DAY })
    ]
  },
  failing: {
    label: 'with failing',
    build: (): Ticket[] => [
      failingTicket({ expiresIn: 4 * DAY }),
      rareTicket({ expiresIn: 3 * DAY }),
      ticket({ expiresIn: 4 * DAY })
    ]
  }
} as const
export type TicketSetId = keyof typeof TICKET_SETS

export const COLLECTION_SIZES = {
  empty: { label: 'empty', count: 0 },
  small: { label: '5', count: 5 },
  typical: { label: '18', count: 18 },
  collector: { label: '60', count: 60 }
} as const
export type CollectionSizeId = keyof typeof COLLECTION_SIZES

export const FLAVORS = {
  'rare-heavy': { label: 'rare-heavy' },
  duplicates: { label: 'duplicates' },
  pending: { label: 'pending' },
  blocked: { label: 'blocked item' }
} as const
export type FlavorId = keyof typeof FLAVORS

/** Build one CollectionInput from the three axes. */
export function composeScenario(
  ticketsId: TicketSetId,
  sizeId: CollectionSizeId,
  flavors: readonly FlavorId[]
): CollectionInput {
  const count = COLLECTION_SIZES[sizeId].count
  let owned = buildOwned(count, flavors.includes('rare-heavy') ? 2 : 7)
  if (flavors.includes('duplicates')) owned = [...owned, ...dupes(4), ...dupes(2)]
  if (flavors.includes('pending')) {
    owned = [...owned, { hash: rareHash(), pending: true }, { hash: randomHash(), pending: true }]
  }
  if (flavors.includes('blocked') && owned.length > 0) {
    // Nudged newest so it lands first under the default sort.
    owned[0] = {
      ...owned[0]!,
      mintedAt: (owned[0]!.mintedAt ?? 0) + 60,
      transferBlocked: { reason: "This one can't travel yet." }
    }
  }
  return { displayName: MOCK_NAME, owned, tickets: TICKET_SETS[ticketsId].build() }
}

/** Dev shortcut: a synthetic mintable ticket + item index guaranteed to
 *  mint an item of the given rarity — lets the panel jump straight to the
 *  reveal ceremony to compare the rare vs common experience. The rarity
 *  band in bytes 0–1 steers the mock's chosenItemHash into the right pool;
 *  the tail is kept clear of the fail suffix. */
export function demoMintTicket(rarity: Rarity): { ticketHash: string; itemIndex: number } {
  const itemIndex = Math.floor(Math.random() * Math.max(1, poolSize(rarity)))
  const roll = rarity === 'rare' ? 1 : RARE_THRESHOLD + 100
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  bytes[0] = (roll >> 8) & 0xff
  bytes[1] = roll & 0xff
  if (bytes[30] === 0x00 && bytes[31] === 0xff) bytes[31] = 0xfe // never the fail suffix
  let h = '0x'
  for (const b of bytes) h += b.toString(16).padStart(2, '0')
  return { ticketHash: h, itemIndex }
}

export interface DevMock {
  label: string
  build: () => CollectionInput
}

export const DEV_MOCKS: DevMock[] = [
  // Aliases onto the axes above — kept so existing ?mock= URLs (and the v1
  // regression checks) keep working.
  { label: 'post-game', build: () => composeScenario('fresh', 'typical', ['blocked']) },
  { label: 'expiring', build: () => composeScenario('expiring', 'small', []) },
  { label: 'fresh-player', build: () => composeScenario('fresh', 'empty', []) },
  { label: 'small (5)', build: () => composeScenario('none', 'small', []) },
  { label: 'typical (18)', build: () => composeScenario('none', 'typical', []) },
  { label: 'collector (60)', build: () => composeScenario('none', 'collector', []) },
  { label: 'rare-heavy (12)', build: () => composeScenario('none', 'typical', ['rare-heavy']) },
  { label: '+ pending', build: () => composeScenario('none', 'small', ['pending']) },
  { label: '+ duplicates', build: () => composeScenario('none', 'small', ['duplicates']) },
  { label: 'empty', build: () => composeScenario('none', 'empty', []) }
]

