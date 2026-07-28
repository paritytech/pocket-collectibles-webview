// Reactive read of the active design variation (<html data-theme>), which
// the ThemeSwitcher flips live. Most theming is pure CSS and needs no JS
// awareness; this hook exists for the few features that only some
// variations offer (e.g. the arcana deck view).

import { useEffect, useState } from 'react'

export function useTheme(): string | null {
  const [theme, setTheme] = useState<string | null>(
    document.documentElement.dataset.theme ?? null
  )
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme ?? null)
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return theme
}
