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
  onDone: () => void
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
export default function MintCeremony({ requestIds, entries, particles, frameRef, onDone }: MintCeremonyProps) {
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

    const tl = gsap.timeline({ onComplete: () => setSettled(true) })
    entries.forEach((entry, i) => {
      const el = cardRefs.current[i]
      if (!el) return
      const result = results.get(entry.hash)
      const face = el.querySelector('.ceremony-card-inner') as HTMLElement | null
      if (!face) return
      const at = i === 0 ? '+=0.15' : '+=0.2'
      const grown = result?.status === 'minted' ? bigScale : () => Math.min(1.7, bigScale(el))

      // Take the stage…
      tl.set(el, { zIndex: 60 }, at)
      tl.to(el, {
        x: () => toCenterX(el),
        y: () => toCenterY(el),
        scale: () => grown(el),
        duration: 0.4,
        ease: EASE.entranceSoft
      })

      if (result?.status === 'minted') {
        const rare = entry.preview.isRare
        tl.to(face, {
          rotateY: 90, duration: rare ? 0.5 : 0.35, ease: EASE.flipIn,
          onStart: () => {
            if (rare) {
              const { x, y } = cardCenter(el)
              particles.current?.legendaryFollowup(x, y)
              haptic.play('legendary-flip')
            }
          }
        })
        tl.add(() => {
          el.classList.add('is-minted')
          const { x, y } = cardCenter(el)
          if (rare) {
            particles.current?.legendaryBurst(x, y)
            haptic.play('legendary-reveal')
          } else {
            particles.current?.dustBurst(x, y)
            haptic.play('reveal-burst')
          }
        })
        tl.to(face, { rotateY: 0, duration: rare ? 0.6 : 0.45, ease: EASE.settleSpring })
        // A beat to admire it at full size before it rejoins the fan.
        tl.to(el, { x: 0, y: 0, scale: 1, duration: 0.45, ease: EASE.settleSoft }, '+=0.35')
      } else {
        // The failed mint: steps up, tries to turn, gives up, and returns
        // still sealed — visibly unharmed. The parade rolls on (one
        // failure never stalls the batch, on-chain or on-screen).
        tl.to(face, { rotateY: 55, duration: 0.3, ease: EASE.flipIn })
        tl.add(() => haptic.play('reveal-pity'))
        tl.to(face, { rotateY: 0, duration: 0.7, ease: EASE.settle })
        tl.add(() => el.classList.add('is-kept'))
        tl.to(el, { x: 0, y: 0, scale: 1, duration: 0.4, ease: EASE.settleSoft }, '+=0.15')
      }
      tl.set(el, { clearProps: 'zIndex' })
    })
    // A short beat before the summary lands; the summary block itself isn't
    // in the DOM until `settled` renders it, so its entrance is CSS-driven
    // (see .ceremony-summary in styles.css) rather than part of this timeline.
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
