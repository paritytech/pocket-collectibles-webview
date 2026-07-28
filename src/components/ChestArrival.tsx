import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import type { ParticleCanvasApi } from './ParticleCanvas'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface ChestArrivalProps {
  ticketCount: number
  particles: React.RefObject<ParticleCanvasApi | null>
  /** The frame, for coordinate translation into the particle canvas. */
  frameRef: React.RefObject<HTMLDivElement | null>
  onOpen: () => void
}

/** The handoff moment (PRD open question 1): the game just ended, native
 *  routed here, and the player's winnings arrive as a sealed bundle —
 *  tap to open, and the shelf entrance plays underneath.
 *
 *  PRODUCTION: the game's results screen shows the chest; tapping it
 *  deep-links to this SPA. The mock stands the moment up inside the page
 *  (?arrival=1) so the beat can be designed before that routing exists. */
export default function ChestArrival({ ticketCount, particles, frameRef, onOpen }: ChestArrivalProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const bundleRef = useRef<HTMLButtonElement>(null)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      gsap.from('.chest-bundle', { y: 80, scale: 0.7, opacity: 0, duration: 0.7, ease: EASE.settleSoft })
      gsap.from('.chest-copy', { y: 16, opacity: 0, duration: 0.5, delay: 0.35, ease: EASE.entranceSoft })
      gsap.to('.chest-bundle', { y: -8, duration: 1.6, ease: EASE.float, yoyo: true, repeat: -1, delay: 0.8 })
    }, rootRef)
    particles.current?.nebulaWisps()
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function open(): void {
    if (opening) return
    setOpening(true)
    haptic.initFromGesture()
    haptic.play('reveal-burst')
    const el = bundleRef.current
    const frame = frameRef.current?.getBoundingClientRect()
    if (el) {
      const r = el.getBoundingClientRect()
      particles.current?.legendaryBurst(
        r.left + r.width / 2 - (frame?.left ?? 0),
        r.top + r.height / 2 - (frame?.top ?? 0)
      )
    }
    if (prefersReducedMotion() || !rootRef.current) { onOpen(); return }
    const tl = gsap.timeline({ onComplete: onOpen })
    tl.to('.chest-bundle', { scale: 1.25, rotation: -4, duration: 0.18, ease: EASE.anticipation })
    tl.to('.chest-bundle', { scale: 0, rotation: 8, opacity: 0, duration: 0.35, ease: EASE.exit })
    tl.to('.chest-copy', { opacity: 0, y: -10, duration: 0.25, ease: EASE.exit }, '<')
    tl.to(rootRef.current, { opacity: 0, duration: 0.4, ease: 'power2.in' }, '-=0.1')
  }

  return (
    <div className="chest" ref={rootRef} role="dialog" aria-modal="true" aria-label="You earned tickets">
      <button type="button" className="chest-bundle" ref={bundleRef} onClick={open} aria-label={`Open your ${ticketCount} new tickets`}>
        {/* A fat stack of sealed tickets — same design language as the shelf. */}
        <span className="chest-ticket chest-ticket--back2" aria-hidden="true" />
        <span className="chest-ticket chest-ticket--back1" aria-hidden="true" />
        <span className="chest-ticket chest-ticket--front" aria-hidden="true">
          <span className="ticket-mystery-eyebrow">★ Ticket ★</span>
          <span className="ticket-mystery-word">×{ticketCount}</span>
        </span>
      </button>
      <div className="chest-copy">
        <h1 className="chest-title">Nicely played!</h1>
        <p className="chest-sub">
          You earned {ticketCount === 1 ? 'a ticket' : `${ticketCount} tickets`} — tap to open.
        </p>
      </div>
    </div>
  )
}
