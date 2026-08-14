import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import type { CollectibleEntry } from '../collectibles/format'
import { formatMintDate } from '../collectibles/format'
import { dropRateLabel } from '../collectibles/resolver'
import { CONCEPTS } from '../collectibles/concepts'
import InfoTip from '../components/InfoTip'
import GiftBundle from '../components/GiftBundle'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface DetailScreenProps {
  list: CollectibleEntry[]
  index: number
  /** On-screen rect of the tile art that was tapped — the zoom origin. */
  originRect: DOMRect
  onClose: () => void
  /** Fired whenever the visible item changes (open + each swipe), with the
   *  newly-shown hash. Drives flow.item_opened telemetry. */
  onShow: (hash: string) => void
}

const SWIPE_THRESHOLD = 48 // px of horizontal travel to commit a swipe

export default function DetailScreen({ list, index: initialIndex, originRect, onClose, onShow }: DetailScreenProps) {
  const [index, setIndex] = useState(initialIndex)
  const entry = list[index]!

  // Glow colour matched to the current item, taken from the swatch hex baked
  // into its catalogue filename. Drives the tinted backdrop, hero glow and
  // rays via the `--glow` custom property on the root.
  const glow = entry.resolved.glow

  const rootRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<HTMLImageElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)

  const isRare = entry.resolved.isRare

  // "Send" isn't available yet — tapping it shows a transient tooltip rather
  // than doing nothing. The button looks disabled but stays tappable so the
  // tap registers (a real `disabled` button swallows the event).
  const [sendHint, setSendHint] = useState(false)
  const sendHintTimer = useRef<number | null>(null)
  const showSendHint = useCallback(() => {
    haptic.play('tap-view')
    setSendHint(true)
    if (sendHintTimer.current) window.clearTimeout(sendHintTimer.current)
    sendHintTimer.current = window.setTimeout(() => setSendHint(false), 1800)
  }, [])
  useEffect(() => () => {
    if (sendHintTimer.current) window.clearTimeout(sendHintTimer.current)
  }, [])

  // ── Mount: shared-element zoom from the tapped tile to the centered hero.
  useLayoutEffect(() => {
    const hero = heroRef.current
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (!hero) return
    const reduce = prefersReducedMotion()

    const ctx = gsap.context(() => {
      if (backdrop) gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: reduce ? 0.2 : 0.4, ease: 'power2.out' })

      if (reduce) {
        gsap.from(hero, { opacity: 0, duration: 0.2 })
      } else {
        const final = hero.getBoundingClientRect()
        // Invert: place the hero visually over the origin tile, then let
        // it animate to its natural centered position (FLIP).
        const scale = originRect.width / final.width
        const dx = (originRect.left + originRect.width / 2) - (final.left + final.width / 2)
        const dy = (originRect.top + originRect.height / 2) - (final.top + final.height / 2)
        gsap.fromTo(hero,
          { x: dx, y: dy, scale, opacity: 0.6 },
          { x: 0, y: 0, scale: 1, opacity: 1, duration: 0.62, ease: EASE.settleSoft }
        )
      }
      if (panel) gsap.from(panel, { y: 28, opacity: 0, duration: 0.5, ease: EASE.entranceSoft, delay: reduce ? 0 : 0.18 })
    }, rootRef)

    haptic.play(isRare ? 'legendary-reveal' : 'tap-view')
    onShow(entry.hash)
    return () => ctx.revert()
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // No tilt anywhere — the hero stays flat. Rare-only flourishes (holo
  // sweep, light rays) are CSS-driven and self-animating; see styles.css.

  // ── Navigation between items (wraps). Cross-fades the hero art.
  const navigate = useCallback((dir: -1 | 1) => {
    if (closingRef.current || list.length < 2) return
    const next = (index + dir + list.length) % list.length
    haptic.play('tap-store')
    const hero = heroRef.current
    if (hero && !prefersReducedMotion()) {
      gsap.fromTo(hero,
        { x: dir * 36, opacity: 0.3 },
        { x: 0, opacity: 1, duration: 0.4, ease: EASE.entranceSoft }
      )
    }
    setIndex(next)
    onShow(list[next]!.hash)
  }, [index, list, onShow])

  // Touch swipe.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let startX = 0, startY = 0, tracking = false
    const down = (e: PointerEvent) => { startX = e.clientX; startY = e.clientY; tracking = true }
    const up = (e: PointerEvent) => {
      if (!tracking) return
      tracking = false
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
        navigate(dx < 0 ? 1 : -1)
      }
    }
    root.addEventListener('pointerdown', down)
    root.addEventListener('pointerup', up)
    return () => {
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('pointerup', up)
    }
  }, [navigate])

  // ── Close: reverse the zoom back toward the origin tile, then unmount.
  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    haptic.play('tap-view')
    const hero = heroRef.current
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (prefersReducedMotion() || !hero) { onClose(); return }
    const final = hero.getBoundingClientRect()
    const scale = originRect.width / final.width
    const dx = (originRect.left + originRect.width / 2) - (final.left + final.width / 2)
    const dy = (originRect.top + originRect.height / 2) - (final.top + final.height / 2)
    if (panel) gsap.to(panel, { y: 24, opacity: 0, duration: 0.25, ease: EASE.exit })
    if (backdrop) gsap.to(backdrop, { opacity: 0, duration: 0.4, delay: 0.05, ease: 'power2.in' })
    gsap.to(hero, {
      x: dx, y: dy, scale, opacity: 0,
      duration: 0.42, ease: EASE.exit,
      onComplete: onClose
    })
  }, [onClose, originRect])

  // Keyboard: Esc closes, arrows navigate (desktop / dev convenience).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft') navigate(-1)
      else if (e.key === 'ArrowRight') navigate(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, navigate])

  return (
    <div
      className={`detail${isRare ? ' detail--rare' : ''}`}
      ref={rootRef}
      style={{ '--glow': glow } as React.CSSProperties}
    >
      <div className="detail-backdrop" ref={backdropRef} onClick={close} />

      <button type="button" className="detail-close" onClick={close} aria-label="Close">×</button>

      {list.length > 1 && (
        <span className="detail-counter">{index + 1} / {list.length}</span>
      )}

      <div className="detail-scroll">
      <div className="detail-stage">
        {list.length > 1 && (
          <button type="button" className="detail-nav detail-nav--prev" onClick={() => navigate(-1)} aria-label="Previous">‹</button>
        )}

        <div className={`detail-hero${isRare ? ' is-rare' : ''}`} ref={heroRef}>
          {/* Rotating light rays are a rare-only flourish; the colour-matched
              glow behind applies to every item (see styles.css). */}
          {isRare && <div className="detail-rays" aria-hidden="true" />}
          <div className="detail-hero-glow" aria-hidden="true" />
          {entry.pending ? (
            /* Unclaimed: the hero stays wrapped — same gift bundle as the
               tile, so the shared-element zoom lands on the identical parcel. */
            <GiftBundle seed={entry.hash} className="detail-gift" />
          ) : (
            <>
              {/* Soft additive camera-flare behind the hero (heavily blurred
                  copy, z-index below the art) — strictly behind the opaque
                  item. */}
              <img
                className="detail-bloom"
                src={entry.resolved.url}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <img
                className="detail-art"
                ref={artRef}
                src={entry.resolved.url}
                alt={entry.resolved.name}
                draggable={false}
              />
              {/* Surface shimmer — a diagonal highlight band swept across,
                  masked by the gem's own PNG alpha so the shine paints only on
                  the gem and never on the transparent surround. */}
              {isRare && (
                <div
                  className="detail-shimmer"
                  aria-hidden="true"
                  style={{
                    maskImage: `url(${entry.resolved.url})`,
                    WebkitMaskImage: `url(${entry.resolved.url})`
                  }}
                />
              )}
            </>
          )}
        </div>

        {list.length > 1 && (
          <button type="button" className="detail-nav detail-nav--next" onClick={() => navigate(1)} aria-label="Next">›</button>
        )}
      </div>

      <div className="detail-panel" ref={panelRef}>
        <div className="detail-titlerow">
          <h2 className="detail-name">{entry.resolved.name}</h2>
          <span className={`rarity-pill rarity-pill--${entry.resolved.rarity}`}>
            {isRare ? '✦ RARE' : 'COMMON'}
          </span>
        </div>

        <dl className="detail-facts">
          {entry.count && entry.count > 1 && (
            <div className="fact">
              <dt>Owned</dt>
              <dd>×{entry.count}</dd>
            </div>
          )}
          <div className="fact">
            <dt>Acquired</dt>
            <dd>
              {entry.pending ? (
                <>Pending finalisation <InfoTip title={CONCEPTS.pending.title} body={CONCEPTS.pending.body} label="What does pending mean?" /></>
              ) : (
                formatMintDate(entry.mintedAt)
              )}
            </dd>
          </div>
          <div className="fact">
            <dt>Collection</dt>
            <dd>{entry.resolved.collection || '—'}</dd>
          </div>
          {entry.resolved.collectionSize > 0 && (
            <div className="fact">
              <dt>In the collection</dt>
              <dd>No. {entry.resolved.collectionIndex} of {entry.resolved.collectionSize}</dd>
            </div>
          )}
          <div className="fact">
            <dt>Drop rate <InfoTip title={CONCEPTS.rarity.title} body={CONCEPTS.rarity.body} label="What does drop rate mean?" /></dt>
            <dd>{dropRateLabel(entry.resolved.rarity)}</dd>
          </div>
        </dl>

        {/* Send a collectible to a friend — not available yet. Looks disabled
            but stays tappable so a tap surfaces the "coming soon" tooltip. */}
        <div className="detail-send-wrap">
          {sendHint && (
            <div className="detail-send-hint" role="status">Functionality coming soon</div>
          )}
          <button
            type="button"
            className="detail-send"
            aria-disabled="true"
            title="Functionality coming soon"
            onClick={showSendHint}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
              <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
            Send
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}
