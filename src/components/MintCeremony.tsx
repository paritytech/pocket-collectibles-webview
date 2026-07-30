import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import type { RequestItemUpdate, RequestStatus } from '../bridge/types'
import { subscribeRequestUpdates } from '../bridge/requests'
import { sendFlowEvent } from '../bridge/send'
import { getCollection } from '../collectibles/mintCollections'
import type { ResolvedCollectible } from '../collectibles/resolver'
import type { ParticleCanvasApi } from './ParticleCanvas'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

/** What the ceremony animates: a ticket + the item the player CHOSE for
 *  it (choose-your-item model — the flip is confirmation theatre now, not
 *  a surprise reveal). */
export interface CeremonyEntry {
  hash: string
  shortCode: string
  collectionId: string
  preview: ResolvedCollectible
}

interface MintCeremonyProps {
  /** The mint request(s) whose update streams drive the beats. */
  requestIds: string[]
  /** Snapshot of what's being minted, captured at request time — the
   *  collection underneath will be replaced mid-ceremony (setCollection is
   *  truth), and the overlay must keep animating the original tickets. */
  entries: CeremonyEntry[]
  particles: React.RefObject<ParticleCanvasApi | null>
  /** The phone frame, for viewport→frame coordinate translation (identity
   *  when embedded full-screen; corrects for the centered desktop frame). */
  frameRef: React.RefObject<HTMLDivElement | null>
  /** How the (common) reveal is chosen: 'signature' gives each collection
   *  a consistent look; 'random' surprises every time. Rares always
   *  override with the epic charge regardless. */
  variantMode?: 'signature' | 'random'
  onDone: () => void
}

/** Number of distinct common-reveal silhouettes (see buildCommonReveal). */
const COMMON_VARIANT_COUNT = 10
/** Stable hash of a string → variant index (signature-per-collection). */
function hashIndex(s: string, n: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % n
}

// User-facing copy stays in the player's world — no crypto vocabulary
// (proofs, transactions, blocks, gas). The technical truth of each stage
// lives in the bridge status names and the mock's narration comments.
const STATUS_COPY: Partial<Record<RequestStatus, string>> = {
  received: 'Starting…',
  awaitingApproval: 'Confirm to mint',
  building: 'Getting your collectibles ready…',
  submitted: 'Working the magic…',
  inBlock: 'Almost there…'
}

/** If the update stream goes quiet this long, assume the host died and let
 *  the user out. Nothing is lost: credits are only consumed on a confirmed
 *  successful mint, so a silent host means the tickets are still theirs. */
const WATCHDOG_MS = 20_000

/** Full-screen mint reveal. Driven by the request's update stream — beats
 *  advance when the bridge reports progress, not on a fixed clock.
 *
 *  While this overlay waits in 'awaitingApproval', PRODUCTION native is
 *  showing its own transaction approval sheet over the WebView (PGAS
 *  sponsored, no fee shown). The webview just breathes underneath it. */
export default function MintCeremony({ requestIds, entries, particles, frameRef, variantMode = 'signature', onDone }: MintCeremonyProps) {
  const reduce = useMemo(() => prefersReducedMotion(), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const [status, setStatus] = useState<RequestStatus>('received')
  const [progress, setProgress] = useState(0)
  const [results, setResults] = useState<Map<string, RequestItemUpdate> | null>(null)
  const [allDone, setAllDone] = useState(false)
  const [settled, setSettled] = useState(false)
  const [stalled, setStalled] = useState(false)
  const revealed = useRef(false)

  // ---- Update streams (one per request, merged) ------------------------
  useEffect(() => {
    let watchdog = 0
    const doneIds = new Set<string>()
    const armWatchdog = () => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(() => {
        setStalled(true)
        sendFlowEvent({ type: 'flow.error', phase: 'mint_timeout', detail: requestIds.join(',') })
      }, WATCHDOG_MS)
    }
    armWatchdog()
    const offs = requestIds.map((id) =>
      subscribeRequestUpdates(id, (update) => {
        armWatchdog()
        setStatus(update.status)
        if (typeof update.progress === 'number') setProgress(update.progress)
        if (update.items && (update.status === 'inBlock' || update.status === 'done')) {
          // Merge per-ticket results across the parallel requests.
          setResults((prev) => {
            const next = new Map(prev)
            for (const item of update.items!) next.set(item.ticketHash, item)
            return next
          })
        }
        if (update.status === 'done' || update.status === 'failed' || update.status === 'rejected') {
          doneIds.add(id)
          if (doneIds.size === requestIds.length) {
            window.clearTimeout(watchdog)
            setAllDone(true)
          }
        }
      })
    )
    return () => { offs.forEach((off) => off()); window.clearTimeout(watchdog) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A stalled or request-level-terminal ceremony lets the user straight
  // out; their tickets are unchanged (failure/rejection consumes nothing).
  const aborted = stalled || status === 'failed' || status === 'rejected'

  // ---- Entrance: cards fan into the center -----------------------------
  useEffect(() => {
    if (reduce) return
    const ctx = gsap.context(() => {
      gsap.from('.ceremony-scrim', { opacity: 0, duration: 0.4, ease: EASE.entranceSoft })
      gsap.from('.ceremony-card', {
        y: 120, opacity: 0, rotate: () => gsap.utils.random(-9, 9),
        duration: 0.9, ease: EASE.settleSoft, stagger: 0.08
      })
      gsap.from('.ceremony-status', { opacity: 0, y: 12, duration: 0.5, delay: 0.4, ease: EASE.entranceSoft })
    }, rootRef)
    particles.current?.nebulaWisps()
    particles.current?.revealStarfield()
    haptic.play('collect-all-appear')
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Building shimmer keyed to reported progress ---------------------
  useEffect(() => {
    if (reduce || status !== 'building') return
    // Element refs, not a selector: the cleanup may run after unmount,
    // when a document-wide '.ceremony-card' lookup would find nothing.
    const cards = cardRefs.current.filter((el): el is HTMLDivElement => !!el)
    if (cards.length === 0) return
    const tl = gsap.to(cards, {
      '--shine': 1, duration: 0.9, ease: EASE.holoPass, stagger: 0.12, yoyo: true, repeat: -1
    })
    return () => {
      tl.kill()
      gsap.set(cards.filter((el) => el.isConnected), { '--shine': 0 })
    }
  }, [status, reduce])

  /** Center of a card in frame-local coordinates for the particle canvas. */
  const cardCenter = (el: HTMLElement): { x: number; y: number } => {
    const rect = el.getBoundingClientRect()
    const frame = frameRef.current?.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2 - (frame?.left ?? 0),
      y: rect.top + rect.height / 2 - (frame?.top ?? 0)
    }
  }

  // ---- The reveal: staggered flips once results are final --------------
  useEffect(() => {
    if (!allDone || !results || revealed.current) return
    revealed.current = true

    if (reduce) {
      // Reduced motion: no flips, no bursts — flip classes on instantly and
      // settle. The staged list itself is the reveal.
      setSettled(true)
      return
    }

    // Each card takes center stage for its reveal: it flies to the middle
    // and grows to ~3× (bounded by the frame) so the flip is THE moment,
    // then settles back into the fan. Function-based values are resolved
    // when each tween starts, so every card measures its own resting spot.
    const stage = rootRef.current?.querySelector('.ceremony-stage') as HTMLElement | null
    const stageRect = stage?.getBoundingClientRect()
    const toCenterX = (el: HTMLElement) => {
      if (!stageRect) return 0
      const r = el.getBoundingClientRect()
      return stageRect.left + stageRect.width / 2 - (r.left + r.width / 2)
    }
    const toCenterY = (el: HTMLElement) => {
      if (!stageRect) return 0
      const r = el.getBoundingClientRect()
      // Bias upward: the status/summary line lives at the stage's bottom.
      return stageRect.top + stageRect.height * 0.42 - (r.top + r.height / 2)
    }
    const bigScale = (el: HTMLElement) => {
      if (!stageRect) return 2.4
      const r = el.getBoundingClientRect()
      return Math.min(3, (stageRect.width * 0.82) / r.width)
    }

    /** RARE — a genuine event: spotlight, hot-gold charge, "RARE" banner,
     *  screen shake, triple burst. Used for rares in single reveals. */
    const revealRare = (el: HTMLElement, face: HTMLElement) => {
      const banner = rootRef.current?.querySelector('.ceremony-rare-banner') as HTMLElement | null
      tl.add(() => {
        el.classList.add('is-charging')
        rootRef.current?.classList.add('ceremony--spotlight')
        haptic.play('threshold-cross')
        particles.current?.nebulaWisps()
      })
      tl.to(el, { '--charge': 1, duration: 1.35, ease: 'power2.in' })
      tl.add(() => { const c = cardCenter(el); particles.current?.legendaryFollowup(c.x, c.y); haptic.play('tap-view') }, '-=1.0')
      tl.add(() => { const c = cardCenter(el); particles.current?.legendaryFollowup(c.x, c.y); haptic.play('tap-view') }, '-=0.6')
      tl.add(() => { const c = cardCenter(el); particles.current?.legendaryFollowup(c.x, c.y); haptic.play('legendary-flip') }, '-=0.3')
      tl.to(el, { scale: () => bigScale(el) * 1.06, duration: 0.16, ease: EASE.anticipation })
      tl.add(() => el.classList.remove('is-charging'))
      tl.to(face, { rotateY: 90, duration: 0.3, ease: EASE.flipIn })
      tl.add(() => {
        el.classList.add('is-minted')
        const c = cardCenter(el)
        particles.current?.legendaryBurst(c.x, c.y)
        particles.current?.legendaryFollowup(c.x, c.y)
        particles.current?.revealStarfield()
        haptic.play('legendary-reveal')
      })
      if (rootRef.current) tl.fromTo(rootRef.current, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1.6, 0.25)' }, '<')
      if (banner) {
        tl.fromTo(banner, { scale: 1.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: EASE.impact }, '<')
        tl.to(banner, { opacity: 0, duration: 0.4, ease: EASE.exit }, '+=0.9')
      }
      tl.to(face, { rotateY: 0, duration: 0.6, ease: EASE.settleSpring }, '<-0.1')
      tl.to(el, { scale: () => bigScale(el), duration: 0.2 }, '<')
      tl.add(() => rootRef.current?.classList.remove('ceremony--spotlight'), '+=0.6')
    }

    /** COMMON — one of ten reveals with genuinely different silhouettes
     *  (flip, spin, iris-pop, barrel, drop-slam, swing, tumble, zoom-punch,
     *  rise, shatter). Each conceals the sealed→art swap (behind a ≥90°
     *  turn or a scale-through-zero). Signature-per-collection by default,
     *  random when variantMode==='random'. Rares never use these. */
    const revealCommon = (el: HTMLElement, face: HTMLElement, entry: CeremonyEntry) => {
      const idx = variantMode === 'random'
        ? Math.floor(Math.random() * COMMON_VARIANT_COUNT)
        : hashIndex(entry.collectionId + entry.preview.name, COMMON_VARIANT_COUNT)
      // Swap art in + burst — called at the concealed moment of each variant.
      const reveal = (flavor: 'dust' | 'sparkle', h: Parameters<typeof haptic.play>[0]) => {
        el.classList.add('is-minted')
        const c = cardCenter(el)
        if (flavor === 'sparkle') particles.current?.sparkleBurst(c.x, c.y)
        else particles.current?.dustBurst(c.x, c.y)
        haptic.play(h)
      }
      const B = () => bigScale(el)

      switch (idx) {
        case 0: // Flip Y — the classic card turn.
          tl.to(face, { rotateY: 90, duration: 0.26, ease: EASE.flipIn })
          tl.add(() => reveal('dust', 'reveal-burst'))
          tl.to(face, { rotateY: 0, duration: 0.42, ease: EASE.settleSpring })
          break
        case 1: // Flip X — a vertical turn.
          tl.to(face, { rotateX: 90, duration: 0.26, ease: EASE.flipIn })
          tl.add(() => reveal('sparkle', 'reveal-burst'))
          tl.to(face, { rotateX: 0, duration: 0.42, ease: EASE.settleSpring })
          break
        case 2: // Iris pop — collapses to nothing, bursts back (no flip).
          tl.to(el, { scale: 0.01, rotation: -25, duration: 0.24, ease: 'power2.in' })
          tl.add(() => reveal('sparkle', 'badge-land'))
          tl.to(el, { scale: B, rotation: 0, duration: 0.55, ease: 'back.out(2.2)' })
          break
        case 3: // Coin spin — spins flat while turning over.
          tl.to(el, { rotation: '+=380', duration: 0.62, ease: 'power2.inOut' })
          tl.to(face, { rotateY: 90, duration: 0.2, ease: EASE.flipIn }, 0.16)
          tl.add(() => reveal('dust', 'reveal-burst'), 0.34)
          tl.to(face, { rotateY: 0, duration: 0.24, ease: EASE.settleSpring }, 0.34)
          break
        case 4: // Barrel roll — a full 360° tumble on Y.
          tl.to(face, { rotateY: 360, duration: 0.7, ease: 'power2.inOut' })
          tl.add(() => reveal('sparkle', 'reveal-burst'), 0.35)
          break
        case 5: // Drop slam — hoists up, slams down with a shake + flip.
          tl.to(el, { y: '-=70', scale: () => B() * 0.94, duration: 0.22, ease: EASE.anticipation })
          tl.to(face, { rotateX: 90, duration: 0.14, ease: EASE.flipIn })
          tl.to(el, { y: '+=70', scale: B, duration: 0.16, ease: 'power3.in' }, '<')
          tl.add(() => { reveal('dust', 'legendary-flip'); if (rootRef.current) gsap.fromTo(rootRef.current, { y: 6 }, { y: 0, duration: 0.4, ease: 'elastic.out(1.6, 0.3)' }) })
          tl.to(face, { rotateX: 0, duration: 0.4, ease: EASE.settleSpring })
          break
        case 6: // Pendulum swing — swings in from an angle, flips, settles.
          tl.to(el, { rotation: -16, duration: 0.18, ease: EASE.anticipation })
          tl.to(face, { rotateY: 90, duration: 0.22, ease: EASE.flipIn })
          tl.add(() => reveal('sparkle', 'reveal-burst'))
          tl.to(face, { rotateY: 0, duration: 0.3, ease: EASE.settleSpring })
          tl.to(el, { rotation: 0, duration: 0.55, ease: 'elastic.out(1, 0.45)' }, '<')
          break
        case 7: // Tumble — a full 360° flip on X.
          tl.to(face, { rotateX: 360, duration: 0.7, ease: 'power2.inOut' })
          tl.add(() => reveal('dust', 'reveal-burst'), 0.35)
          break
        case 8: // Zoom punch — lunges toward you, snaps the turn.
          tl.to(el, { scale: () => B() * 1.28, duration: 0.18, ease: EASE.anticipation })
          tl.to(face, { rotateY: 90, duration: 0.16, ease: EASE.flipIn })
          tl.add(() => reveal('sparkle', 'legendary-flip'))
          tl.to(face, { rotateY: 0, duration: 0.24, ease: EASE.impact })
          tl.to(el, { scale: B, duration: 0.4, ease: EASE.settleSpring }, '<')
          break
        case 9: // Rise — sweeps up from below with a turn.
          tl.to(el, { y: '+=90', duration: 0.2, ease: EASE.anticipation })
          tl.to(face, { rotateY: 90, duration: 0.2, ease: EASE.flipIn })
          tl.add(() => reveal('sparkle', 'reveal-burst'))
          tl.to(face, { rotateY: 0, duration: 0.28, ease: EASE.settleSpring })
          tl.to(el, { y: '-=90', duration: 0.5, ease: EASE.settleSoft }, '<')
          break
      }
    }

    // ---- Batch (Mint All) — a synchronized WAVE, not a queue -------------
    if (entries.length > 1) {
      const tl = gsap.timeline({ onComplete: () => setSettled(true) })
      const anyRare = entries.some((e) => results.get(e.hash)?.status === 'minted' && e.preview.isRare)
      const banner = rootRef.current?.querySelector('.ceremony-rare-banner') as HTMLElement | null
      tl.add(() => haptic.play('collect-all-appear'), 0)
      entries.forEach((entry, i) => {
        const el = cardRefs.current[i]
        const face = el?.querySelector('.ceremony-card-inner') as HTMLElement | null
        if (!el || !face) return
        const result = results.get(entry.hash)
        const at = 0.25 + i * 0.13 // the ripple
        const rare = result?.status === 'minted' && entry.preview.isRare
        if (result?.status === 'minted') {
          tl.to(face, { rotateY: 90, duration: 0.24, ease: EASE.flipIn }, at)
          tl.add(() => {
            el.classList.add('is-minted')
            const c = cardCenter(el)
            if (rare) { particles.current?.legendaryBurst(c.x, c.y); haptic.play('legendary-reveal') }
            else { particles.current?.dustBurst(c.x, c.y); haptic.play('reveal-burst') }
          }, at + 0.24)
          tl.to(face, { rotateY: 0, duration: 0.4, ease: EASE.settleSpring }, at + 0.26)
          if (rare) {
            // A rare in the batch still gets "extra": it pops forward with
            // a golden encore even amid the wave.
            tl.to(el, { scale: 1.16, duration: 0.22, ease: EASE.anticipation }, at + 0.66)
            tl.add(() => { const c = cardCenter(el); particles.current?.legendaryFollowup(c.x, c.y) }, at + 0.7)
            tl.to(el, { scale: 1, duration: 0.42, ease: EASE.settleSoft }, at + 0.9)
          }
        } else {
          tl.to(face, { rotateY: 50, duration: 0.24, ease: EASE.flipIn }, at)
          tl.add(() => { haptic.play('reveal-pity'); el.classList.add('is-kept') }, at + 0.24)
          tl.to(face, { rotateY: 0, duration: 0.5, ease: EASE.settle }, at + 0.28)
        }
      })
      // Celebratory finale — a screen-wide sparkle, and the RARE banner if
      // any rare landed in the batch.
      tl.add(() => { particles.current?.revealStarfield(); if (anyRare) haptic.play('legendary-reveal') }, '>-0.2')
      if (anyRare && banner) {
        tl.fromTo(banner, { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: EASE.impact }, '<')
        tl.to(banner, { opacity: 0, duration: 0.5, ease: EASE.exit }, '+=0.8')
      }
      tl.to({}, { duration: 0.3 })
      return () => { tl.kill() }
    }

    // ---- Single reveal — one card takes center stage ---------------------
    const tl = gsap.timeline({ onComplete: () => setSettled(true) })
    entries.forEach((entry, i) => {
      const el = cardRefs.current[i]
      if (!el) return
      const result = results.get(entry.hash)
      const face = el.querySelector('.ceremony-card-inner') as HTMLElement | null
      if (!face) return
      const at = i === 0 ? '+=0.15' : '+=0.2'
      const grown = result?.status === 'minted' ? bigScale : () => Math.min(1.7, bigScale(el))

      tl.set(el, { zIndex: 60 }, at)
      tl.to(el, { x: () => toCenterX(el), y: () => toCenterY(el), scale: () => grown(el), duration: 0.4, ease: EASE.entranceSoft })

      if (result?.status === 'minted' && entry.preview.isRare) {
        revealRare(el, face)
      } else if (result?.status === 'minted') {
        revealCommon(el, face, entry)
      } else {
        // The failed mint: steps up, tries to turn, gives up, returns sealed.
        tl.to(face, { rotateY: 55, duration: 0.3, ease: EASE.flipIn })
        tl.add(() => haptic.play('reveal-pity'))
        tl.to(face, { rotateY: 0, duration: 0.7, ease: EASE.settle })
        tl.add(() => el.classList.add('is-kept'))
      }
      tl.to(el, { x: 0, y: 0, scale: 1, duration: 0.5, ease: EASE.settleSoft }, '+=0.5')
      tl.set(el, { clearProps: 'zIndex' })
    })
    tl.to({}, { duration: 0.35 })
    return () => { tl.kill() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone, results])

  const summary = useMemo(() => {
    if (!results) return ''
    let minted = 0
    let kept = 0
    for (const r of results.values()) {
      if (r.status === 'minted') minted++
      else if (r.status === 'failed') kept++
    }
    const parts: string[] = []
    if (minted > 0) parts.push(`${minted} minted`)
    if (kept > 0) parts.push(`${kept} ticket${kept > 1 ? 's' : ''} kept`)
    return parts.join(' · ')
  }, [results])

  const showSummary = settled || (reduce && allDone)

  return (
    <div className={`ceremony${reduce ? ' ceremony--reduced' : ''}`} ref={rootRef} role="dialog" aria-modal="true" aria-label="Minting">
      <div className="ceremony-scrim" aria-hidden="true" />
      <div className="ceremony-rare-banner" aria-hidden="true">✦ RARE ✦</div>
      <div className="ceremony-stage">
        <div className={`ceremony-fan ceremony-fan--${Math.min(entries.length, 5)}`}>
          {entries.map((entry, i) => {
            const result = results?.get(entry.hash)
            // Sealed tickets: the card glows with its COLLECTION tint until
            // the flip; `.is-minted` swaps --glow to the item's own color
            // (see styles.css). Failed tickets never reveal — the secret
            // survives the trip.
            const glowVars = {
              '--glow': getCollection(entry.collectionId).tint,
              '--glow-item': entry.preview.glow
            } as React.CSSProperties
            return (
              <div
                key={entry.hash}
                ref={(el) => { cardRefs.current[i] = el }}
                className={[
                  'ceremony-card',
                  entry.preview.isRare ? 'ceremony-card--rare' : '',
                  reduce && result?.status === 'minted' ? 'is-minted' : '',
                  reduce && result?.status === 'failed' ? 'is-kept' : ''
                ].filter(Boolean).join(' ')}
                style={glowVars}
              >
                <div className="ceremony-card-inner">
                  <div className="ceremony-rays" aria-hidden="true" />
                  <div className="ticket-burst" aria-hidden="true" />
                  <div className="ceremony-mystery" aria-hidden="true">
                    <span className="ticket-mystery-eyebrow">★ {getCollection(entry.collectionId).label} ★</span>
                    <span className="ticket-mystery-word">Claim 1</span>
                  </div>
                  <img className="ceremony-card-art" src={entry.preview.url} alt={entry.preview.name} draggable={false} />
                  <span className="ceremony-card-name">{entry.preview.name}</span>
                  {result?.status === 'failed' && (
                    <span className="ceremony-fail-chip">{result.reason ?? 'Kept as a ticket'}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {!showSummary && !aborted && (
          <div className="ceremony-status" role="status">
            <span className="ceremony-status-text">{STATUS_COPY[status] ?? '…'}</span>
            {status === 'building' && (
              <span className="ceremony-progress" aria-hidden="true">
                <span className="ceremony-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </span>
            )}
          </div>
        )}

        {aborted && (
          <div className="ceremony-status" role="status">
            <span className="ceremony-status-text">
              {status === 'rejected' ? 'Mint cancelled — your tickets are safe.' : 'Still working… your tickets are safe.'}
            </span>
            <button type="button" className="ceremony-done-btn" onClick={onDone}>Back</button>
          </div>
        )}

        {showSummary && (
          <div className="ceremony-summary">
            <span className="ceremony-summary-text">{summary}</span>
            <button
              type="button"
              className="ceremony-done-btn"
              onClick={() => { haptic.play('tap-store'); onDone() }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
