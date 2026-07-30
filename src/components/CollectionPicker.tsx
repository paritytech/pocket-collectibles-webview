import { useEffect, useMemo, useRef } from 'react'
import gsap from 'gsap'
import type { TicketEntry } from '../collectibles/tickets'
import { orderedCollections, type MintCollection } from '../collectibles/mintCollections'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface CollectionPickerProps {
  entry: TicketEntry
  favourites: readonly string[]
  onToggleFavourite: (id: string) => void
  /** Mint this ticket into the chosen collection. */
  onChoose: (collectionId: string) => void
  onClose: () => void
  variant?: 'sheet' | 'inline'
  backLabel?: string
}

/** Choose which COLLECTION a ticket mints into (the only mint choice —
 *  the collection derives the item). Built for ~10 collections: a
 *  scrollable grid, favourites pinned first with a star to add/remove.
 *  Tickets stay secretive, so cards show each collection's identity — its
 *  tint and blurb — never the item this ticket would become. */
export default function CollectionPicker({
  entry, favourites, onToggleFavourite, onChoose, onClose, variant = 'sheet', backLabel = 'Cancel'
}: CollectionPickerProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const inline = variant === 'inline'
  const favSet = useMemo(() => new Set(favourites), [favourites])
  const ordered = useMemo(() => orderedCollections(favourites), [favourites])
  const firstNonFav = ordered.findIndex((c) => !favSet.has(c.id))

  useEffect(() => {
    if (prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      if (inline) gsap.from(sheetRef.current, { x: 60, opacity: 0, duration: 0.4, ease: EASE.entranceSoft })
      else {
        gsap.from(scrimRef.current, { opacity: 0, duration: 0.25, ease: EASE.entranceSoft })
        gsap.from(sheetRef.current, { y: '100%', duration: 0.45, ease: EASE.entranceSoft })
      }
      gsap.from('.collpick-card', { y: 14, opacity: 0, duration: 0.3, stagger: 0.03, ease: EASE.entranceSoft, delay: 0.12 })
    }, sheetRef)
    return () => ctx.revert()
  }, [inline])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = (c: MintCollection) => {
    haptic.initFromGesture()
    haptic.play('collect-all-appear')
    onChoose(c.id)
  }

  return (
    <div className={`picker${inline ? ' picker--inline' : ''}`} role="dialog" aria-modal="true" aria-label="Choose a collection">
      {!inline && <div className="picker-scrim" ref={scrimRef} onClick={onClose} />}
      <div className="picker-sheet" ref={sheetRef}>
        {inline
          ? <button type="button" className="picker-back" onClick={onClose}><span aria-hidden="true">‹ </span>{backLabel}</button>
          : <div className="picker-grip" aria-hidden="true" />}
        <h2 className="picker-title">
          Mint your {entry.rarity === 'rare' ? 'rare' : 'common'}
          {entry.rarity === 'rare' && <span className="picker-rare" aria-hidden="true"> ✦</span>} into…
        </h2>
        <p className="picker-sub">Pick a collection — the surprise inside is revealed when you mint.</p>

        <div className="collpick-grid" role="listbox" aria-label="Collections">
          {ordered.map((c, i) => {
            const fav = favSet.has(c.id)
            return (
              <div key={c.id} className="collpick-wrap">
                {i === firstNonFav && favourites.length > 0 && (
                  <div className="collpick-divider" aria-hidden="true">All collections</div>
                )}
                <div className="collpick-card" style={{ '--glow': c.tint } as React.CSSProperties}>
                  <button type="button" className="collpick-choose" role="option" aria-selected="false" onClick={() => choose(c)}>
                    <span className="collpick-emblem" aria-hidden="true">◈</span>
                    <span className="collpick-text">
                      <span className="collpick-label">{c.label}</span>
                      <span className="collpick-blurb">{c.blurb}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`collpick-fav${fav ? ' is-fav' : ''}`}
                    aria-pressed={fav}
                    aria-label={fav ? `Remove ${c.label} from favourites` : `Add ${c.label} to favourites`}
                    onClick={() => { haptic.initFromGesture(); haptic.play('tap-store'); onToggleFavourite(c.id) }}
                  >
                    {fav ? '★' : '☆'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <p className="picker-foot">★ a collection to make it your default for one-tap Mint all.</p>
      </div>
    </div>
  )
}
