import { useState, useCallback } from 'react'
import type { CollectibleEntry } from '../collectibles/format'
import { formatRelative } from '../collectibles/format'
import GiftBundle from './GiftBundle'
import { haptic } from '../haptics/engine'

interface CollectibleTileProps {
  entry: CollectibleEntry
  /** Invoked on tap with the entry and the on-screen rect of the art, so
   *  the detail view can run a shared-element zoom from exactly here. */
  onOpen: (entry: CollectibleEntry, artRect: DOMRect) => void
}

/** One collectible in the gallery grid. Presentational: entrance + reflow
 *  animations are driven by the parent (GalleryScreen) via GSAP on the
 *  `.tile` element; the tile owns only its own image-load + press feel.
 *
 *  Each item floats on a colour-matched glow blob (tinted by the swatch hex
 *  baked into the catalogue filename) plus a soft additive blurred copy
 *  BEHIND it for a camera-flare — no drop shadows and nothing painted over the
 *  art, per the mock-ups' ethereal "floating in space" look. */
export default function CollectibleTile({ entry, onOpen }: CollectibleTileProps) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const { resolved, pending } = entry

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      haptic.initFromGesture()
      haptic.play('tap-view')
      const art = e.currentTarget.querySelector('.tile-art, .tile-gift') as HTMLElement | null
      const rect = (art ?? e.currentTarget).getBoundingClientRect()
      onOpen(entry, rect)
    },
    [entry, onOpen]
  )

  const onArtLoad = useCallback(() => {
    setLoaded(true)
  }, [])

  // Tinted glow colour as a CSS custom property, taken from the swatch hex
  // baked into the collectible's catalogue filename.
  const glowStyle = { '--glow': resolved.glow } as React.CSSProperties

  return (
    <button
      type="button"
      className={[
        'tile',
        resolved.isRare ? 'tile--rare' : '',
        pending ? 'tile--pending' : '',
        loaded ? 'is-loaded' : ''
      ].filter(Boolean).join(' ')}
      style={glowStyle}
      onClick={handleClick}
      aria-label={`${resolved.name}${resolved.isRare ? ', rare' : ''}${pending ? ', unclaimed' : ''}${entry.count && entry.count > 1 ? `, ${entry.count} owned` : ''}`}
    >
      <div className="tile-frame">
        {/* Colour-matched glow blob behind the item (brighter for rare).
            Unclaimed tiles skip it — the glow is tuned for dark frames and
            the wrapped parcel carries its own colour. */}
        {!pending && <div className="tile-glow-blob" aria-hidden="true" />}
        <div className="tile-art-wrap">
          {pending ? (
            /* Unclaimed: the art stays wrapped — a gift bundle whose paper +
               ribbon are picked from the credit's hash. */
            <GiftBundle seed={entry.hash} className="tile-gift" />
          ) : !failed ? (
            <>
              {/* Soft additive camera-flare BEHIND the item (heavily blurred
                  copy of the art). Strictly behind the opaque subject, so the
                  image itself is presented as-is. */}
              <img
                className="tile-bloom"
                src={resolved.url}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                draggable={false}
              />
              <img
                className="tile-art"
                src={resolved.url}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onLoad={onArtLoad}
                onError={() => {
                  setFailed(true)
                  const w = window as unknown as { __ASSET_FAILURES__?: number }
                  w.__ASSET_FAILURES__ = (w.__ASSET_FAILURES__ ?? 0) + 1
                }}
              />
            </>
          ) : (
            <div className="tile-art tile-art--fallback" aria-hidden="true">◈</div>
          )}
        </div>
        {resolved.isRare && <span className="tile-rare-badge" aria-hidden="true">✦ RARE</span>}
        {pending && <span className="tile-pending-badge">UNCLAIMED</span>}
        {entry.count && entry.count > 1 && (
          <span className="tile-count-badge" aria-hidden="true">×{entry.count}</span>
        )}
      </div>
      <div className="tile-meta">
        <span className="tile-name">{resolved.name}</span>
        <span className="tile-sub">
          <span className="tile-collection">{resolved.collection || entry.shortCode}</span>
          <span className="tile-dot">·</span>
          <span className="tile-when">{formatRelative(entry.mintedAt)}</span>
        </span>
      </div>
    </button>
  )
}
