import { useMemo } from 'react'
import type { TicketEntry } from '../collectibles/tickets'
import { EXPIRY_WARN_S, isTicketExpired } from '../collectibles/tickets'
import TicketCard from './TicketCard'
import { haptic } from '../haptics/engine'

interface TicketShelfProps {
  entries: TicketEntry[]
  /** Tap a mintable ticket → the item picker (choose-your-item). */
  onPick: (entry: TicketEntry) => void
  /** Mint every mintable ticket at once ("surprise me"). */
  onMintAll?: (tickets: TicketEntry[]) => void
}

/** The mint-first shelf: rarity-tier ticket vouchers in a horizontal rail.
 *  Each ticket is its own call to action — there's no "Mint all", because
 *  every mint is a deliberate item choice.
 *
 *  Note there is deliberately NO fee/price anywhere on this surface:
 *  minting is free to the user (PGAS-sponsored), and the PRD forbids even
 *  hinting at a gas cost. */
export default function TicketShelf({ entries, onPick, onMintAll }: TicketShelfProps) {
  const mintable = useMemo(() => entries.filter((e) => e.state === 'mintable' && !isTicketExpired(e)), [entries])
  // Expiry never arrives unannounced (PRD success metric): surface the
  // soonest-expiring ticket as a banner as soon as it crosses the warn
  // threshold. PRODUCTION: native mirrors the same expiresAt data with a
  // scheduled local notification, so the warning reaches the user even
  // with the app closed.
  const soonest = useMemo(() => {
    const now = Date.now() / 1000
    let best: TicketEntry | null = null
    for (const e of entries) {
      if (e.expiresAt === undefined) continue
      if (e.expiresAt <= now) continue // already gone — the banner can't help
      if (e.expiresAt - now > EXPIRY_WARN_S) continue
      if (!best || e.expiresAt < (best.expiresAt ?? Infinity)) best = e
    }
    return best
  }, [entries])

  if (entries.length === 0) return null

  return (
    <section className="ticket-shelf" aria-label="Tickets ready to mint">
      <div className="ticket-shelf-head">
        <h2 className="ticket-shelf-title">
          <span aria-hidden="true">◇ </span>
          {entries.length === 1 ? '1 ticket' : `${entries.length} tickets`}
        </h2>
        {onMintAll && mintable.length > 1 ? (
          <button
            type="button"
            className="mint-all-btn"
            onClick={() => { haptic.initFromGesture(); haptic.play('collect-all-appear'); onMintAll(mintable) }}
          >
            Mint all ({mintable.length})
          </button>
        ) : (
          <span className="ticket-shelf-hint">Tap one to mint</span>
        )}
      </div>
      {soonest && (
        <p className="ticket-banner" role="status">
          <span aria-hidden="true">⏳ </span>
          A ticket expires soon — mint it to keep it.
        </p>
      )}
      <div className="ticket-rail" role="list">
        {entries.map((entry) => (
          <TicketCard key={entry.hash} entry={entry} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}
