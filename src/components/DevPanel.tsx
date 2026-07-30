import { useState } from 'react'
import type { CollectionInput } from '../bridge/types'
import {
  COLLECTION_SIZES,
  FLAVORS,
  TICKET_SETS,
  composeScenario,
  type CollectionSizeId,
  type FlavorId,
  type TicketSetId
} from '../devMocks'
import type { Rarity } from '../collectibles/resolver'

interface DevPanelProps {
  /** Load a composed scenario (routes through the mock native). */
  onScenario: (input: CollectionInput) => void
  /** One-shot moments. */
  onChest: () => void
  onIntro: () => void
  /** Jump straight to the reveal ceremony with a forced outcome. */
  onDemoMint: (rarity: Rarity) => void
  /** Reveal variety: true = a random animation each mint; false =
   *  signature-per-collection. */
  alwaysDifferent: boolean
  onToggleAlwaysDifferent: () => void
  /** Initial axis state, usually parsed from the URL by App. */
  initial?: { tickets?: TicketSetId; collection?: CollectionSizeId; flavors?: FlavorId[] }
}

/** Dev-only scenario composer (?dev=1): three independent axes — what's on
 *  the ticket shelf × how much is collected × collection flavors — plus
 *  one-shot moments. Every change reloads the composed state and mirrors
 *  it into the URL (?tickets=&collection=&flavors=) so states are
 *  shareable, like themes. */
export default function DevPanel({ onScenario, onChest, onIntro, onDemoMint, alwaysDifferent, onToggleAlwaysDifferent, initial }: DevPanelProps) {
  const [ticketsId, setTicketsId] = useState<TicketSetId>(initial?.tickets ?? 'fresh')
  const [sizeId, setSizeId] = useState<CollectionSizeId>(initial?.collection ?? 'typical')
  const [flavors, setFlavors] = useState<ReadonlySet<FlavorId>>(new Set(initial?.flavors ?? []))

  function syncUrl(t: TicketSetId, c: CollectionSizeId, f: ReadonlySet<FlavorId>): void {
    const url = new URL(window.location.href)
    url.searchParams.set('tickets', t)
    url.searchParams.set('collection', c)
    if (f.size) url.searchParams.set('flavors', [...f].join(','))
    else url.searchParams.delete('flavors')
    url.searchParams.delete('mock') // axes replace any alias that booted us
    window.history.replaceState(null, '', url)
  }

  function apply(t: TicketSetId, c: CollectionSizeId, f: ReadonlySet<FlavorId>): void {
    onScenario(composeScenario(t, c, [...f]))
    syncUrl(t, c, f)
  }

  return (
    <div className="dev-panel dev-panel--axes" role="group" aria-label="Dev scenario composer">
      <div className="dev-group">
        <span className="dev-group-label">tickets</span>
        {(Object.keys(TICKET_SETS) as TicketSetId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`dev-panel-btn${ticketsId === id ? ' is-active' : ''}`}
            onClick={() => {
              setTicketsId(id)
              apply(id, sizeId, flavors)
              // post-game IS the chest moment: picking it replays the full
              // game→collectibles arrival, not just the shelf state.
              if (id === 'fresh') onChest()
            }}
          >
            {TICKET_SETS[id].label}
          </button>
        ))}
      </div>
      <div className="dev-group">
        <span className="dev-group-label">collection</span>
        {(Object.keys(COLLECTION_SIZES) as CollectionSizeId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`dev-panel-btn${sizeId === id ? ' is-active' : ''}`}
            onClick={() => { setSizeId(id); apply(ticketsId, id, flavors) }}
          >
            {COLLECTION_SIZES[id].label}
          </button>
        ))}
      </div>
      <div className="dev-group">
        <span className="dev-group-label">flavors</span>
        {(Object.keys(FLAVORS) as FlavorId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`dev-panel-btn${flavors.has(id) ? ' is-active' : ''}`}
            aria-pressed={flavors.has(id)}
            onClick={() => {
              const next = new Set(flavors)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              setFlavors(next)
              apply(ticketsId, sizeId, next)
            }}
          >
            {FLAVORS[id].label}
          </button>
        ))}
      </div>
      <div className="dev-group">
        <span className="dev-group-label">reveal</span>
        <button type="button" className="dev-panel-btn dev-panel-btn--rare" onClick={() => onDemoMint('rare')} title="Jump to the reveal with a guaranteed rare">
          ✦ mint rare
        </button>
        <button type="button" className="dev-panel-btn" onClick={() => onDemoMint('common')} title="Jump to the reveal with a common, for comparison">
          mint common
        </button>
        <button
          type="button"
          className={`dev-panel-btn${alwaysDifferent ? ' is-active' : ''}`}
          aria-pressed={alwaysDifferent}
          onClick={onToggleAlwaysDifferent}
          title="Random reveal animation each mint (vs signature-per-collection)"
        >
          always different
        </button>
      </div>
      <div className="dev-group">
        <span className="dev-group-label">moments</span>
        {/* The chest handoff lives on the post-game chip above — picking it
            replays the arrival, so no separate trigger needed. */}
        <button type="button" className="dev-panel-btn" onClick={onIntro} title="Replay the first-run intro">
          ↻ intro
        </button>
        <button
          type="button"
          className="dev-panel-btn dev-panel-btn--reload"
          onClick={() => window.location.reload()}
          title="Reload to reset all state"
        >
          ↻ reload
        </button>
      </div>
    </div>
  )
}
