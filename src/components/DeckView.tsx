import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import CollectibleTile from './CollectibleTile'
import type { CollectibleEntry } from '../collectibles/format'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface DeckViewProps {
  /** Already sorted/collapsed — same list the grid renders. */
  entries: CollectibleEntry[]
  /** Same contract as the grid: open detail from the tapped card's art. */
  onOpen: (list: CollectibleEntry[], index: number, artRect: DOMRect) => void
}

const SWIPE_THRESHOLD = 48
/** Cards rendered at once: the top card + up to three peeking behind. */
const STACK_DEPTH = 4

/** The owned collection as a deck: one card front and center, the rest
 *  stacked behind. Swipe (or use the arrows) to flip through; tap the top
 *  card for the detail view. Reuses CollectibleTile wholesale, so every
 *  theme's card treatment (arcana's trading card, loot's slot…) carries
 *  straight into the deck. */
export default function DeckView({ entries, onOpen }: DeckViewProps) {
  const [index, setIndex] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const swipedRef = useRef(false)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)

  // The list can shrink under us (a re-delivery, a duplicate collapse).
  const current = entries.length ? index % entries.length : 0

  function navigate(dir: -1 | 1): void {
    if (busyRef.current || entries.length < 2) return
    haptic.initFromGesture()
    haptic.play('tap-store')
    const stage = stageRef.current
    const top = stage?.querySelector<HTMLElement>('[data-depth="0"]')
    const next = () => setIndex((i) => (i + dir + entries.length) % entries.length)
    if (prefersReducedMotion() || !top) { next(); return }
    busyRef.current = true
    // The top card is dealt away in the swipe direction…
    gsap.to(top, {
      x: -dir * 150,
      rotation: -dir * 9,
      opacity: 0,
      duration: 0.26,
      ease: EASE.exit,
      onComplete: () => {
        next()
        // …and the fresh arrangement settles in from the opposite side:
        // the new top card sweeps in, the ones behind shuffle forward.
        requestAnimationFrame(() => {
          const s = stageRef.current
          if (!s) { busyRef.current = false; return }
          const newTop = s.querySelector<HTMLElement>('[data-depth="0"]')
          const rest = s.querySelectorAll<HTMLElement>('[data-depth]:not([data-depth="0"])')
          if (newTop) {
            gsap.fromTo(newTop,
              { x: dir * 120, rotation: dir * 8, opacity: 0 },
              { x: 0, rotation: 0, opacity: 1, duration: 0.45, ease: EASE.settleSoft, onComplete: () => { busyRef.current = false } }
            )
          } else {
            busyRef.current = false
          }
          if (rest.length) {
            gsap.from(rest, { y: '+=10', duration: 0.35, ease: EASE.entranceSoft, stagger: 0.05 })
          }
        })
      }
    })
  }

  // Keyboard flipping (desktop / dev convenience). Detail view overlays
  // this listener with its own when open — fine, it stops propagation of
  // nothing; both act on arrows but the deck is behind the modal then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') navigate(-1)
      else if (e.key === 'ArrowRight') navigate(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length])

  if (entries.length === 0) return null

  const visible = Math.min(STACK_DEPTH, entries.length)

  return (
    <div className="deck" aria-label={`Deck view, card ${current + 1} of ${entries.length}`}>
      <div
        className="deck-stage"
        ref={stageRef}
        onPointerDown={(e) => { pointerStart.current = { x: e.clientX, y: e.clientY } }}
        onPointerUp={(e) => {
          const start = pointerStart.current
          pointerStart.current = null
          if (!start) return
          const dx = e.clientX - start.x
          const dy = e.clientY - start.y
          if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            swipedRef.current = true // swallow the click that follows
            navigate(dx < 0 ? 1 : -1)
          }
        }}
      >
        {/* Render back-to-front so the DOM order matches paint order under
            the explicit z-indexes (and hit-testing favors the top card). */}
        {Array.from({ length: visible }, (_, i) => visible - 1 - i).map((d) => {
          const entry = entries[(current + d) % entries.length]!
          const isTop = d === 0
          return (
            <div
              key={entry.hash}
              className="deck-card"
              data-depth={d}
              style={{
                zIndex: 20 - d,
                transform: `translateY(${d * 14}px) scale(${1 - d * 0.055}) rotate(${d === 0 ? 0 : d % 2 ? d * 1.8 : d * -1.4}deg)`,
                opacity: 1 - d * 0.16,
                pointerEvents: isTop ? 'auto' : 'none'
              }}
              aria-hidden={!isTop}
            >
              <CollectibleTile
                entry={entry}
                onOpen={(_entry, rect) => {
                  if (swipedRef.current) { swipedRef.current = false; return }
                  onOpen(entries, current, rect)
                }}
              />
            </div>
          )
        })}
      </div>

      <div className="deck-nav-row">
        <button type="button" className="deck-nav" onClick={() => navigate(-1)} aria-label="Previous card">‹</button>
        <span className="deck-counter">{current + 1} / {entries.length}</span>
        <button type="button" className="deck-nav" onClick={() => navigate(1)} aria-label="Next card">›</button>
      </div>
    </div>
  )
}
