import { useState } from 'react'
import type { CollectibleEntry } from '../collectibles/format'
import { haptic } from '../haptics/engine'

interface CollectionStackProps {
  label: string
  entries: CollectibleEntry[]
  onOpen: (label: string) => void
}

/** One collection in the grouped view: a stack of cards with the rarest
 *  (or newest) item as its cover. Tapping opens the collection's items.
 *  Reuses the tile anatomy so every theme's card treatment applies. */
export default function CollectionStack({ label, entries, onOpen }: CollectionStackProps) {
  const [loaded, setLoaded] = useState(false)
  const cover = entries.find((e) => e.resolved.isRare) ?? entries[0]!
  const total = entries.reduce((n, e) => n + (e.count ?? 1), 0)
  const rare = entries.filter((e) => e.resolved.isRare).length

  return (
    <button
      type="button"
      className={`tile tile--stack${loaded ? ' is-loaded' : ''}`}
      style={{ '--glow': cover.resolved.glow } as React.CSSProperties}
      onClick={() => {
        haptic.initFromGesture()
        haptic.play('tap-view')
        onOpen(label)
      }}
      aria-label={`${label} collection, ${total} item${total === 1 ? '' : 's'}${rare ? `, ${rare} rare` : ''}. Open it.`}
    >
      <span className="stack-behind" aria-hidden="true" />
      <div className="tile-frame">
        <div className="tile-glow-blob" aria-hidden="true" />
        <div className="tile-art-wrap">
          <img
            className="tile-art"
            src={cover.resolved.url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
          />
        </div>
        <span className="tile-count-badge" aria-hidden="true">×{total}</span>
        {rare > 0 && <span className="tile-rare-badge" aria-hidden="true">✦ {rare}</span>}
      </div>
      <div className="tile-meta">
        <span className="tile-name">{label}</span>
        <span className="tile-sub">
          <span className="tile-collection">{total} item{total === 1 ? '' : 's'}</span>
        </span>
      </div>
    </button>
  )
}
