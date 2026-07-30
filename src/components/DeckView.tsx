import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import CollectibleTile from './CollectibleTile'
import type { CollectibleEntry } from '../collectibles/format'
import { formatMintDate } from '../collectibles/format'
import { dropRateLabel } from '../collectibles/resolver'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface DeckViewProps {
  /** Already sorted/collapsed — same list the grid renders. */
  entries: CollectibleEntry[]
  /** Same contract as the grid: open detail from the tapped card's art. */
  onOpen: (list: CollectibleEntry[], index: number, artRect: DOMRect) => void
}

/** Cards rendered at once: the top card + up to three peeking behind. */
const STACK_DEPTH = 4
const FLING_DISTANCE = 90
const FLING_VELOCITY = 0.5
const TAP_SLOP = 8

/** Resting transform for a card at stack depth `d` (0 = front). GSAP is the
 *  SINGLE source of truth for card transforms — the render never sets one —
 *  so drag/fling and the reshuffle can never fight leftover inline styles. */
function resting(d: number) {
  return {
    x: 0,
    y: d * 14,
    rotation: d === 0 ? 0 : d % 2 ? d * 1.8 : d * -1.4,
    rotationY: 0,
    scale: 1 - d * 0.055,
    opacity: 1 - d * 0.16
  }
}

/** The owned collection as a deck you can PLAY with: drag the top card and
 *  fling it away — the card underneath is revealed and rises to the front;
 *  tap a card to flip it over and read its details; the back's "View full"
 *  opens the detail view. Reuses CollectibleTile, so every theme's card
 *  treatment carries into the deck. */
export default function DeckView({ entries, onOpen }: DeckViewProps) {
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const swallowTapRef = useRef(false)
  const drag = useRef<{ id: number; startX: number; startY: number; lastX: number; lastT: number; vx: number; active: boolean } | null>(null)
  // Which hash sat at which depth last render, so the reshuffle can tell a
  // card that MOVED (animate to its new slot) from one that just ENTERED
  // (intro from off-screen / behind). Also gates first-paint (no animation).
  const prevDepths = useRef<Map<string, number>>(new Map())
  const mounted = useRef(false)

  const len = entries.length
  const current = len ? ((index % len) + len) % len : 0
  const topEl = () => stageRef.current?.querySelector<HTMLElement>('[data-depth="0"]') ?? null

  // ---- Position every card via GSAP after each (re)render --------------
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const cards = stage.querySelectorAll<HTMLElement>('.deck-card')
    const nextMap = new Map<string, number>()
    const reduce = prefersReducedMotion()
    cards.forEach((el) => {
      const hash = el.dataset.hash ?? ''
      const d = Number(el.dataset.depth)
      nextMap.set(hash, d)
      const target = resting(d)
      if (!mounted.current || reduce) { gsap.set(el, target); return }
      if (prevDepths.current.has(hash)) {
        // A mover — glide to its new slot (depth 1 → 0 rises to the front).
        gsap.to(el, { ...target, duration: 0.42, ease: EASE.settleSoft, overwrite: 'auto' })
      } else if (d === 0) {
        // The new front card (going back): slide in from the left.
        gsap.fromTo(el, { ...target, x: -320, rotation: -10, opacity: 0 }, { ...target, duration: 0.45, ease: EASE.settleSoft, overwrite: 'auto' })
      } else {
        // A new card joining the back of the stack: fade up from behind.
        gsap.fromTo(el, { ...resting(d + 0.7), opacity: 0 }, { ...target, duration: 0.45, ease: EASE.settleSoft, overwrite: 'auto' })
      }
    })
    prevDepths.current = nextMap
    mounted.current = true
    busyRef.current = false
  }, [current, len])

  const step = useCallback((dir: -1 | 1) => {
    setFlipped(false)
    setIndex((i) => i + dir)
  }, [])

  /** Forward: throw the held top card off in `throwX`'s direction, then
   *  advance — the reshuffle reveals the next card underneath. */
  const flingNext = useCallback((throwX: number) => {
    if (busyRef.current || len < 2) return
    haptic.initFromGesture(); haptic.play('tap-store')
    const top = topEl()
    if (prefersReducedMotion() || !top) { step(1); return }
    busyRef.current = true
    const dir = throwX < 0 ? -1 : 1
    gsap.to(top, { x: dir * 360, rotation: dir * 20, opacity: 0, duration: 0.32, ease: EASE.exit, onComplete: () => step(1) })
  }, [len, step])

  /** Backward: bring the previous card over the top from the left. */
  const goPrev = useCallback(() => {
    if (busyRef.current || len < 2) return
    haptic.initFromGesture(); haptic.play('tap-store')
    step(-1) // the layout effect slides the new front card in from the left
  }, [len, step])

  // ---- Drag the top card ----------------------------------------------
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (busyRef.current || flipped) return
    const top = topEl(); if (!top) return
    top.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastT: e.timeStamp, vx: 0, active: false }
  }, [flipped])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.active && Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return
    d.active = true
    const dt = e.timeStamp - d.lastT
    if (dt > 0) d.vx = (e.clientX - d.lastX) / dt
    d.lastX = e.clientX; d.lastT = e.timeStamp
    const top = topEl()
    if (top) gsap.set(top, { x: dx, y: dy * 0.25, rotation: dx * 0.04, rotationY: dx * 0.06, transformPerspective: 700 })
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.id !== e.pointerId) return
    const top = topEl()
    if (!d.active || !top) return
    const dx = e.clientX - d.startX
    swallowTapRef.current = true // this gesture was a drag, not a tap
    if ((Math.abs(dx) > FLING_DISTANCE || Math.abs(d.vx) > FLING_VELOCITY) && len > 1) {
      flingNext(dx)
    } else {
      haptic.play('tap-view')
      gsap.to(top, { ...resting(0), duration: 0.5, ease: 'elastic.out(1, 0.5)' })
    }
  }, [len, flingNext])

  const tapFlip = useCallback(() => {
    if (swallowTapRef.current) { swallowTapRef.current = false; return }
    if (busyRef.current) return
    haptic.initFromGesture(); haptic.play('badge-land')
    setFlipped((f) => !f)
  }, [])

  const openDetail = useCallback(() => {
    const art = stageRef.current?.querySelector<HTMLElement>('[data-depth="0"] .tile-art')
      ?? stageRef.current?.querySelector<HTMLElement>('[data-depth="0"]')
    if (art) onOpen(entries, current, art.getBoundingClientRect())
  }, [entries, current, onOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') flingNext(-1)
      else if (e.key === 'f') setFlipped((f) => !f)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, flingNext])

  if (len === 0) return null
  const visible = Math.min(STACK_DEPTH, len)

  return (
    <div className="deck" aria-label={`Deck view, card ${current + 1} of ${len}`}>
      <div className="deck-stage" ref={stageRef}>
        {/* Back-to-front so paint order matches the z-indexes. */}
        {Array.from({ length: visible }, (_, i) => visible - 1 - i).map((depth) => {
          const entry = entries[(current + depth) % len]!
          const isTop = depth === 0
          return (
            <div
              key={entry.hash}
              className="deck-card"
              data-depth={depth}
              data-hash={entry.hash}
              style={{ zIndex: 20 - depth, pointerEvents: isTop ? 'auto' : 'none' }}
              aria-hidden={!isTop}
              {...(isTop ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClick: tapFlip } : {})}
            >
              {isTop ? (
                <div className={`deck-flip${flipped ? ' is-flipped' : ''}`}>
                  <div className="deck-face deck-face--front">
                    {/* onOpen is a no-op here — a tap flips; detail opens
                        from the back's "View full". */}
                    <CollectibleTile entry={entry} onOpen={() => {}} />
                  </div>
                  <div className="deck-face deck-face--back" style={{ '--glow': entry.resolved.glow } as React.CSSProperties} aria-hidden="true">
                    <span className="deck-back-mark">◈</span>
                    <span className="deck-back-name">{entry.resolved.name}</span>
                    <span className="deck-back-rarity">{entry.resolved.isRare ? '✦ Rare' : 'Common'}</span>
                    <dl className="deck-back-facts">
                      <div><dt>Collection</dt><dd>{entry.collectionLabel || '—'}</dd></div>
                      {entry.resolved.collectionSize > 0 && (
                        <div><dt>No.</dt><dd>{entry.resolved.collectionIndex} / {entry.resolved.collectionSize}</dd></div>
                      )}
                      <div><dt>Acquired</dt><dd>{formatMintDate(entry.mintedAt)}</dd></div>
                      <div><dt>Drop rate</dt><dd>{dropRateLabel(entry.resolved.rarity)}</dd></div>
                    </dl>
                    <button
                      type="button"
                      className="deck-back-open"
                      onClick={(e) => { e.stopPropagation(); haptic.play('tap-view'); openDetail() }}
                    >
                      View full ›
                    </button>
                  </div>
                </div>
              ) : (
                <CollectibleTile entry={entry} onOpen={() => {}} />
              )}
            </div>
          )
        })}
      </div>

      <div className="deck-nav-row">
        <button type="button" className="deck-nav" onClick={goPrev} aria-label="Previous card">‹</button>
        <span className="deck-counter">{current + 1} / {len}</span>
        <button type="button" className="deck-nav" onClick={() => flingNext(-1)} aria-label="Next card">›</button>
      </div>
      <p className="deck-hint" aria-hidden="true">Drag to flick through · tap to flip</p>
    </div>
  )
}
