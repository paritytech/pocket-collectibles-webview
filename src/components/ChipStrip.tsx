// A horizontal strip of single-select chips. Generic — the mint flow's
// collection picker is the first user, but nothing here is specific to it.

interface Chip {
  id: number
  label: string
  /** Rendered dimmed and unselectable (e.g. a collection that can't mint). */
  disabled?: boolean
}

interface ChipStripProps {
  items: Chip[]
  selectedId: number | null
  onSelect: (id: number) => void
  ariaLabel?: string
}

export default function ChipStrip({ items, selectedId, onSelect, ariaLabel }: ChipStripProps) {
  return (
    <div className="chip-strip" role="tablist" aria-label={ariaLabel}>
      {items.map((chip) => {
        const on = chip.id === selectedId
        return (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`chip${on ? ' chip--on' : ''}`}
            disabled={chip.disabled}
            onClick={() => onSelect(chip.id)}
          >
            {chip.label}
          </button>
        )
      })}
    </div>
  )
}
