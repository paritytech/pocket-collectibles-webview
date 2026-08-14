import { useEffect, type RefObject } from 'react'

/** Call `handler` when a pointer press lands outside `ref`'s element — the
 *  generic "click outside to dismiss" behaviour (dropdowns, popovers). Only
 *  active while `enabled` (default true), so a closed menu adds no listener.
 *  Uses `pointerdown` so it fires before a click completes elsewhere. */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: () => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return
    const onDown = (event: PointerEvent): void => {
      const el = ref.current
      if (el && !el.contains(event.target as Node)) handler()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [ref, handler, enabled])
}
