import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import type { TicketEntry } from '../collectibles/tickets'
import {
  MINT_COLLECTIONS,
  DEFAULT_COLLECTION_ID,
  collectionCatalog,
  type CatalogItem
} from '../collectibles/mintCollections'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface ItemPickerProps {
  entry: TicketEntry
  /** Mint the chosen item: which collection, which catalog item. */
  onMint: (collectionId: string, item: CatalogItem) => void
  onClose: () => void
}

/** Choose-your-item mint sheet: pick a collection, browse the items it
 *  offers at the ticket's rarity tier, pick the exact one to mint.
 *
 *  PRODUCTION: catalogs come from each collection's jollity_api module,
 *  including live supply (an item can be minted out). ⚠ Player-chosen
 *  items also need runtime support — see BridgeRequest.request.mint. */
export default function ItemPicker({ entry, onMint, onClose }: ItemPickerProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const [collectionId, setCollectionId] = useState(DEFAULT_COLLECTION_ID)
  const [picked, setPicked] = useState<CatalogItem | null>(null)

  const items = useMemo(
    () => collectionCatalog(collectionId, entry.rarity),
    [collectionId, entry.rarity]
  )

  useEffect(() => {
    if (prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      gsap.from(scrimRef.current, { opacity: 0, duration: 0.25, ease: EASE.entranceSoft })
      gsap.from(sheetRef.current, { y: '100%', duration: 0.45, ease: EASE.entranceSoft })
    }, sheetRef)
    return () => ctx.revert()
  }, [])

  // Fresh grid entrance on collection switch. fromTo with explicit end
  // values + clearProps — a bare from() re-run under StrictMode captures a
  // mid-fade opacity as its target and leaves the grid stuck dim.
  useEffect(() => {
    if (prefersReducedMotion()) return
    const cards = sheetRef.current?.querySelectorAll('.itempicker-item')
    if (!cards || !cards.length) return
    const tween = gsap.fromTo(cards,
      { y: 12, opacity: 0 },
      {
        y: 0, opacity: 1, duration: 0.3, ease: EASE.entranceSoft,
        stagger: { amount: 0.25, from: 'start' },
        clearProps: 'opacity,transform'
      }
    )
    return () => { tween.kill() }
  }, [collectionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="picker" role="dialog" aria-modal="true" aria-label="Choose what to mint">
      <div className="picker-scrim" ref={scrimRef} onClick={onClose} />
      <div className="picker-sheet" ref={sheetRef}>
        <div className="picker-grip" aria-hidden="true" />
        <h2 className="picker-title">
          Mint a {entry.rarity === 'rare' ? 'rare' : 'common'}
          {entry.rarity === 'rare' && <span className="picker-rare" aria-hidden="true"> ✦</span>}
        </h2>
        <p className="picker-sub">Your ticket covers any of these — pick the one you want.</p>

        <div className="sort-row itempicker-tabs" role="tablist" aria-label="Collection">
          {MINT_COLLECTIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={collectionId === c.id}
              className={`sort-chip${collectionId === c.id ? ' is-active' : ''}`}
              onClick={() => {
                if (collectionId === c.id) return
                haptic.initFromGesture()
                haptic.play('tap-store')
                setCollectionId(c.id)
                setPicked(null)
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="itempicker-grid" role="listbox" aria-label="Items you can mint">
          {items.map((item) => {
            const active = picked?.index === item.index
            return (
              <button
                key={item.index}
                type="button"
                role="option"
                aria-selected={active}
                className={`itempicker-item${active ? ' is-picked' : ''}`}
                style={{ '--glow': item.resolved.glow } as React.CSSProperties}
                onClick={() => {
                  haptic.initFromGesture()
                  haptic.play('tap-view')
                  setPicked(active ? null : item)
                }}
              >
                <span className="itempicker-thumb">
                  <img src={item.resolved.url} alt="" loading="lazy" decoding="async" draggable={false} />
                </span>
                <span className="itempicker-name">{item.resolved.name}</span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className="mint-all-btn itempicker-confirm"
          disabled={!picked}
          onClick={() => {
            if (!picked) return
            haptic.initFromGesture()
            haptic.play('collect-all-appear')
            onMint(collectionId, picked)
          }}
        >
          {picked ? `Mint ${picked.resolved.name}` : 'Pick one to mint'}
        </button>
      </div>
    </div>
  )
}
