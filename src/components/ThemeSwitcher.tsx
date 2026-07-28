import { useState } from 'react'
import { haptic } from '../haptics/engine'

// Design-review affordance: flips between the visual variations live (no
// reload — everything is CSS custom properties keyed off <html
// data-theme>) and keeps the URL shareable via replaceState. This is a
// prototype tool; a shipped app would pick ONE direction (or let native
// deliver a theme preference over the bridge).

const THEMES: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: null, label: 'Ethereal' },
  { id: 'gilded', label: 'Gilded' },
  { id: 'arcana', label: 'Arcana' },
  { id: 'loot', label: 'Loot' },
  { id: 'pixel', label: 'Pixel' }
]

export default function ThemeSwitcher() {
  const [active, setActive] = useState<string | null>(
    document.documentElement.dataset.theme ?? null
  )

  function apply(id: string | null): void {
    haptic.initFromGesture()
    haptic.play('tap-store')
    if (id) document.documentElement.dataset.theme = id
    else delete document.documentElement.dataset.theme
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('theme', id)
    else url.searchParams.delete('theme')
    window.history.replaceState(null, '', url)
    setActive(id)
  }

  return (
    <div className="theme-switch" role="group" aria-label="Design variation">
      {THEMES.map((t) => (
        <button
          key={t.label}
          type="button"
          className={`theme-switch-btn${active === t.id ? ' is-active' : ''}`}
          aria-pressed={active === t.id}
          onClick={() => apply(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
