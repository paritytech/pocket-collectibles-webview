import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import type { CollectibleEntry } from '../collectibles/format'
import { formatMintDate } from '../collectibles/format'
import { dropRateLabel } from '../collectibles/resolver'
import { CONCEPTS } from '../collectibles/concepts'
import InfoTip from '../components/InfoTip'
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
  /** Start the send flow for this item. Omitted → the button shows the
   *  "coming soon" hint (v1 behavior). */
  onSend?: (entry: CollectibleEntry) => void
  /** Open the game an item is playable in (UJ-6). Only rendered for items
   *  carrying a gameLink. */
  onOpenGame?: (entry: CollectibleEntry) => void
}

const SWIPE_THRESHOLD = 48 // px of horizontal travel to commit a swipe

export default function DetailScreen({ list, index: initialIndex, originRect, onClose, onShow, onSend, onOpenGame }: DetailScreenProps) {
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
  const cardRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const navigatingRef = useRef(false)

  const isRare = entry.resolved.isRare

  // Send: live when the host provides onSend and the item is transferable.
  // A blocked item (or a host without the write path) keeps the button
  // tappable so the tap can explain itself — a real `disabled` button
  // swallows the event and says nothing.
  const [sendHint, setSendHint] = useState<string | null>(null)
  const sendHintTimer = useRef<number | null>(null)
  const canSend = !!onSend && !entry.transferBlocked && !entry.pending
  const handleSendTap = useCallback(() => {
    if (canSend) {
      haptic.initFromGesture()
      haptic.play('tap-store')
      onSend!(entry)
      return
    }
    haptic.play('tap-view')
    // PRD: "if a transfer is blocked, the UI shows why."
    setSendHint(
      entry.transferBlocked?.reason ??
      (entry.pending ? 'Not quite yours yet — almost there.' : 'Functionality coming soon')
    )
    if (sendHintTimer.current) window.clearTimeout(sendHintTimer.current)
    sendHintTimer.current = window.setTimeout(() => setSendHint(null), 2200)
  }, [canSend, entry, onSend])
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

  // ── Navigation between items (wraps). The WHOLE card is dealt away in
  // the swipe direction and the next one sweeps in from the other side —
  // the item changes as a card change, not an art swap inside a fixed
  // frame. Content swaps at the midpoint (setIndex), so the out-animation
  // shows the old card and the in-animation the new one.
  const navigate = useCallback((dir: -1 | 1) => {
    if (closingRef.current || navigatingRef.current || list.length < 2) return
    const next = (index + dir + list.length) % list.length
    haptic.play('tap-store')
    const commit = () => { setIndex(next); onShow(list[next]!.hash) }
    const card = cardRef.current
    if (!card || prefersReducedMotion()) { commit(); return }
    navigatingRef.current = true
    gsap.to(card, {
      x: -dir * 130,
      rotation: -dir * 5,
      opacity: 0,
      duration: 0.24,
      ease: EASE.exit,
      onComplete: () => {
        commit()
        gsap.fromTo(card,
          { x: dir * 140, rotation: dir * 6, opacity: 0 },
          {
            x: 0, rotation: 0, opacity: 1,
            duration: 0.5, ease: EASE.settleSoft,
            onComplete: () => { navigatingRef.current = false }
          }
        )
      }
    })
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

      {/* Prev / next live OUTSIDE the card, on the screen edges — the card
          is one object that gets dealt in and out whole. */}
      {list.length > 1 && (
        <button type="button" className="detail-nav detail-nav--prev" onClick={() => navigate(-1)} aria-label="Previous">‹</button>
      )}
      {list.length > 1 && (
        <button type="button" className="detail-nav detail-nav--next" onClick={() => navigate(1)} aria-label="Next">›</button>
      )}

      <div className="detail-scroll">
      <div className="detail-card" ref={cardRef}>
      {/* Trading-card furniture (title bar above the art, type line below).
          Decorative duplicates of the panel's data, aria-hidden and hidden
          by default — revealed only by themes that dress the detail view
          as a card (themes.css: arcana). */}
      <div className="detail-cardline detail-cardline--title" aria-hidden="true">
        <span className="detail-cardline-name">{entry.resolved.name}</span>
        <span className="detail-cardline-gem" />
      </div>
      <div className="detail-stage">
        <div className={`detail-hero${isRare ? ' is-rare' : ''}`} ref={heroRef}>
          {/* Rotating light rays are a rare-only flourish; the colour-matched
              glow behind applies to every item (see styles.css). */}
          {isRare && <div className="detail-rays" aria-hidden="true" />}
          <div className="detail-hero-glow" aria-hidden="true" />
          {/* Soft additive camera-flare behind the hero (heavily blurred copy,
              z-index below the art) — strictly behind the opaque item. */}
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
          {/* Surface shimmer — a diagonal highlight band swept across, masked
              by the gem's own PNG alpha so the shine paints only on the gem
              and never on the transparent surround. */}
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
        </div>

      </div>

      <div className="detail-cardline detail-cardline--type" aria-hidden="true">
        <span>{entry.resolved.collection || 'Curio'}</span>
        <span className="detail-cardline-set">{isRare ? '✦' : '●'}</span>
      </div>

      <div
        className="detail-panel"
        ref={panelRef}
        data-code={entry.shortCode}
        data-rarity={isRare ? 'R' : 'C'}
        data-num={entry.resolved.collectionSize > 0
          ? `${String(entry.resolved.collectionIndex).padStart(4, '0')}/${entry.resolved.collectionSize}`
          : '—'}
      >
        {/* Card-native text box: the facts as prose + a power/toughness-
            style stat box, MTG-fashion. Hidden by default (aria-hidden —
            the real facts list below carries the accessible data);
            revealed by card-dressing themes, which hide the facts table. */}
        <div className="detail-cardtext" aria-hidden="true">
          <p className="detail-cardtext-line">
            Minted {formatMintDate(entry.mintedAt)}.
          </p>
          <p className="detail-cardtext-flavor">
            {isRare
              ? 'Few decks ever hold one — most only hear the stories.'
              : 'A faithful companion for any collection.'}
          </p>
          {/* Rarity as a word — per-item drop percentages are all fractions
              of a percent, so "~0.2%" read as rare when it was a common.
              Rares wear the same gold badge as the gallery tiles. */}
          <span className={`detail-cardtext-pt${isRare ? ' detail-cardtext-pt--rare' : ''}`}>
            {entry.count && entry.count > 1
              ? `${isRare ? '✦ ' : ''}×${entry.count}`
              : isRare ? '✦ Rare' : 'Common'}
          </span>
        </div>
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

        {/* The loud, frequent action lives IN the box… */}
        {entry.gameLink && onOpenGame && (
          <button
            type="button"
            className="detail-play"
            onClick={() => {
              haptic.initFromGesture()
              haptic.play('tap-store')
              onOpenGame(entry)
              setSendHint(`Opening ${entry.gameLink!.label}…`)
              if (sendHintTimer.current) window.clearTimeout(sendHintTimer.current)
              sendHintTimer.current = window.setTimeout(() => setSendHint(null), 2000)
            }}
          >
            <span aria-hidden="true">▶ </span>Play in {entry.gameLink.label}
          </button>
        )}
      </div>

      {/* …the rare one sits quietly BELOW it, border-only. */}
      <div className="detail-send-wrap">
        {sendHint && (
          <div className="detail-send-hint" role="status">{sendHint}</div>
        )}
        <button
          type="button"
          className={`detail-send${canSend ? ' detail-send--live' : ''}`}
          aria-disabled={!canSend}
          onClick={handleSendTap}
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
