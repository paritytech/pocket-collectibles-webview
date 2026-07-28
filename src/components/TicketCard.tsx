import { useCallback } from 'react'
import type { TicketEntry } from '../collectibles/tickets'
import { useCountdown } from '../hooks/useCountdown'
import { haptic } from '../haptics/engine'

interface TicketCardProps {
  entry: TicketEntry
  /** Tap on a mintable ticket: open the item picker (choose-your-item —
   *  the player picks collection + exact item of the ticket's tier). */
  onPick: (entry: TicketEntry) => void
}

/** One unminted claim credit — a rarity-tier voucher. The face announces
 *  the TIER (a rare ticket is unmistakably gold), never an outcome: what
 *  it becomes is the player's choice at mint time. */
export default function TicketCard({ entry, onPick }: TicketCardProps) {
  const { state, rarity } = entry
  const countdown = useCountdown(entry.expiresAt)
  const mintable = state === 'mintable' && !countdown?.expired
  const rare = rarity === 'rare'

  const handleClick = useCallback(() => {
    if (!mintable) return
    haptic.initFromGesture()
    haptic.play(rare ? 'badge-land' : 'tap-view')
    onPick(entry)
  }, [entry, mintable, onPick, rare])

  // Rarity carries the tint: gold promises a rare, violet a common. An
  // expiring ticket keeps its rarity tint but its BACKGROUND turns warning
  // yellow (see .ticket-card--expiring in themes.css).
  const expiring = !!countdown && (countdown.warn || countdown.urgent) && !countdown.expired
  const glowStyle = { '--glow': rare ? '255 202 40' : '134 146 255' } as React.CSSProperties
  const stateLabel = state === 'finalizing' ? 'almost ready' : 'ready'
  const timeLabel = countdown ? `, ${countdown.expired ? 'expired' : `${countdown.label} left`}` : ''

  return (
    <button
      type="button"
      className={[
        'ticket-card',
        rare ? 'ticket-card--rare' : '',
        expiring ? 'ticket-card--expiring' : '',
        state === 'finalizing' ? 'ticket-card--finalizing' : '',
        countdown?.expired ? 'ticket-card--expired' : '',
        'is-loaded'
      ].filter(Boolean).join(' ')}
      style={glowStyle}
      onClick={handleClick}
      aria-label={
        `${rare ? 'Rare' : 'Common'} ticket, ${stateLabel}${timeLabel}. ` +
        (mintable
          ? `Tap to choose which ${rare ? 'rare' : 'common'} collectible to mint.`
          : 'Not mintable yet.')
      }
    >
      <div className="ticket-frame">
        <div className="tile-glow-blob" aria-hidden="true" />
        <div className="ticket-burst" aria-hidden="true" />
        <div className="ticket-mystery" aria-hidden="true">
          <span className="ticket-mystery-eyebrow">
            {rare ? '✦ Rare ✦' : '★ Common ★'}
          </span>
          <span className="ticket-mystery-word">Claim 1</span>
        </div>
        {/* Mintable is the default — it isn't labeled. Only the exception
            (not provable yet) wears a chip. */}
        {state === 'finalizing' && (
          <span className="ticket-state-chip" aria-hidden="true">almost ready…</span>
        )}
        {countdown && (
          <span
            className={[
              'ticket-expiry-chip',
              countdown.expired ? '' : countdown.urgent ? 'ticket-expiry-chip--urgent' : countdown.warn ? 'ticket-expiry-chip--warn' : ''
            ].filter(Boolean).join(' ')}
            aria-hidden="true"
          >
            {countdown.label}
          </span>
        )}
      </div>
    </button>
  )
}
