// Ticket view-model helpers: turn raw bridge Tickets into the shape the
// shelf renders, plus rarity derivation and expiry math. Mirrors format.ts
// for owned items.
//
// CHOOSE-YOUR-ITEM model: a ticket is a rarity-tier voucher — it promises
// ONE mint of its tier, the player picks the exact item at mint time.

import type { Ticket, TicketState } from '../bridge/types'
import { shortCode } from './format'
import { RARE_THRESHOLD, type Rarity } from './resolver'

/** A fully-resolved ticket ready for the UI. */
export interface TicketEntry {
  /** Normalized hash (lowercase, no 0x) — the React key. */
  hash: string
  /** 0x-prefixed hash for display / bridge requests. */
  hashHex: string
  shortCode: string
  state: TicketState
  /** What this ticket entitles: a rare or a common mint. */
  rarity: Rarity
  expiresAt?: number
}

/** Expiry thresholds (seconds remaining). Warn early and loudly — the PRD
 *  success metric is literally "expiry without prior warning = 0". */
export const EXPIRY_WARN_S = 24 * 3600
export const EXPIRY_URGENT_S = 3600

/** A ticket's rarity tier, from the same roll the resolver uses: bytes 0–1
 *  of the credit hash under RARE_THRESHOLD → rare. Malformed hashes read
 *  as common (never over-promise). */
export function ticketRarity(hash: string): Rarity {
  const h = hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash
  const roll = parseInt(h.slice(0, 4), 16)
  return Number.isFinite(roll) && roll < RARE_THRESHOLD ? 'rare' : 'common'
}

export function buildTicketEntry(ticket: Ticket): TicketEntry {
  const entry: TicketEntry = {
    hash: ticket.hash,
    hashHex: `0x${ticket.hash}`,
    shortCode: shortCode(ticket.hash),
    state: ticket.state,
    rarity: ticketRarity(ticket.hash)
  }
  if (typeof ticket.expiresAt === 'number') entry.expiresAt = ticket.expiresAt
  return entry
}

/** Build all shelf entries, sorted so the most urgent tickets lead:
 *  mintable before finalizing, rare before common within a state, then
 *  soonest-expiring first, hash-stable. */
export function buildTicketEntries(tickets: Ticket[]): TicketEntry[] {
  const out = tickets.map(buildTicketEntry)
  out.sort((a, b) => {
    const sa = a.state === 'mintable' ? 0 : 1
    const sb = b.state === 'mintable' ? 0 : 1
    if (sa !== sb) return sa - sb
    const ra = a.rarity === 'rare' ? 0 : 1
    const rb = b.rarity === 'rare' ? 0 : 1
    if (ra !== rb) return ra - rb
    const ea = a.expiresAt ?? Infinity
    const eb = b.expiresAt ?? Infinity
    if (ea !== eb) return ea - eb
    return a.hash.localeCompare(b.hash)
  })
  return out
}

/** True once the ticket's retention window has closed. Expired tickets
 *  render grayed and can't be minted; the credit is gone (or about to be)
 *  on the People Chain, so the next delivery usually removes them. */
export function isTicketExpired(entry: { expiresAt?: number }, nowMs: number = Date.now()): boolean {
  return typeof entry.expiresAt === 'number' && entry.expiresAt <= nowMs / 1000
}

/** Compact countdown label: "5d 4h", "20h", "45m", "<1m", "expired". */
export function formatCountdown(expiresAt: number, nowMs: number = Date.now()): string {
  const left = Math.floor(expiresAt - nowMs / 1000)
  if (left <= 0) return 'expired'
  const d = Math.floor(left / 86_400)
  const h = Math.floor((left % 86_400) / 3600)
  const m = Math.floor((left % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return `${h}h`
  if (m > 0) return `${m}m`
  return '<1m'
}
