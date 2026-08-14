import { useMemo, useRef, useState } from 'react'
import { useClickOutside } from '../hooks/useClickOutside'

// A searchable single-select dropdown. Generic — the send flow's recipient
// picker is the first user, but nothing here is specific to it: pass options,
// the selected value, and a change handler.

export interface SelectOption {
  value: string
  label: string
}

interface SearchableSelectProps {
  options: SelectOption[]
  value: string | null
  onChange: (value: string) => void
  placeholder?: string
  /** Shown in the filter box. */
  searchPlaceholder?: string
  ariaLabel?: string
  disabled?: boolean
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  ariaLabel,
  disabled
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useClickOutside(rootRef, () => setOpen(false), open)

  const selected = options.find((o) => o.value === value) ?? null
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  function choose(v: string): void {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="select" ref={rootRef}>
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={selected ? 'select-value' : 'select-value select-value--empty'}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="select-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="select-panel" role="listbox" aria-label={ariaLabel}>
          <input
            type="text"
            className="select-search"
            placeholder={searchPlaceholder}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="select-options">
            {filtered.length === 0 ? (
              <li className="select-empty">No matches</li>
            ) : (
              filtered.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className={`select-option${o.value === value ? ' select-option--on' : ''}`}
                    onClick={() => choose(o.value)}
                  >
                    {o.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
