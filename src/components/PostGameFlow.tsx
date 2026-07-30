import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import type { TicketEntry } from '../collectibles/tickets'
import TicketCard from './TicketCard'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface PostGameFlowProps {
  entry: TicketEntry
  index: number
  total: number
  /** Open the item picker for this ticket (mint continues the flow). */
  onMint: (entry: TicketEntry) => void
  /** Leave this ticket for later, move to the next one. */
  onSkip: () => void
  /** Leave the whole flow — straight to the collection. */
  onExit: () => void
  /** Mint every remaining mintable ticket at once ("surprise me"). Shown
   *  only when there's more than one to make it worthwhile. */
  onMintAll?: () => void
}

/** The guided post-game moment: right after the chest opens, the fresh
 *  tickets present themselves one by one — mint each on the spot or skip.
 *  Everything skipped stays on the shelf for later; nothing is lost by
 *  leaving (PRODUCTION: this is pure UX flow, no bridge traffic until a
 *  mint is actually confirmed in the picker). */
export default function PostGameFlow({ entry, index, total, onMint, onSkip, onExit, onMintAll }: PostGameFlowProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  // Deal the current ticket in whenever it changes.
  useEffect(() => {
    if (prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      gsap.fromTo('.pgflow-card',
        { x: 90, rotation: 4, opacity: 0 },
        { x: 0, rotation: 0, opacity: 1, duration: 0.45, ease: EASE.settleSoft }
      )
    }, rootRef)
    return () => ctx.revert()
  }, [entry.hash])

  useEffect(() => {
    if (prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      gsap.from('.pgflow-copy, .pgflow-actions', {
        y: 16, opacity: 0, duration: 0.4, stagger: 0.08, ease: EASE.entranceSoft
      })
    }, rootRef)
    return () => ctx.revert()
  }, [])

  const last = index === total - 1

  return (
    <div className="pgflow" ref={rootRef} role="dialog" aria-modal="true" aria-label="Mint your tickets">
      <div className="pgflow-copy">
        <span className="pgflow-counter">Ticket {index + 1} of {total}</span>
        <h1 className="pgflow-title">
          {entry.rarity === 'rare' ? 'A rare one!' : 'Your ticket'}
        </h1>
      </div>
      <div className="pgflow-card">
        <TicketCard entry={entry} onPick={onMint} />
      </div>
      <div className="pgflow-actions">
        {/* PRIMARY — mint THIS ticket (pick its collection, then mint one). */}
        <button
          type="button"
          className="pgflow-primary"
          onClick={() => { haptic.initFromGesture(); haptic.play('tap-store'); onMint(entry) }}
        >
          Mint
        </button>
        {/* SECONDARY — mint every remaining ticket at once. */}
        {total > 1 && onMintAll && (
          <button
            type="button"
            className="pgflow-secondary"
            onClick={() => { haptic.initFromGesture(); haptic.play('collect-all-appear'); onMintAll() }}
          >
            ✦ Mint all {total}
          </button>
        )}
        {/* TERTIARY — quiet skips. */}
        <div className="pgflow-links">
          {!last && (
            <button type="button" className="pgflow-link" onClick={() => { haptic.initFromGesture(); haptic.play('tap-view'); onSkip() }}>
              Skip this one
            </button>
          )}
          <button type="button" className="pgflow-link" onClick={onExit}>
            {last ? 'Skip — to my collection' : 'Skip all'}
          </button>
        </div>
      </div>
    </div>
  )
}
