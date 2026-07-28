// Reusable long-press detection for touch + mouse, via pointer events.
// Fires `onLongPress` after the threshold if the pointer hasn't moved or
// been cancelled; suppresses the click that would otherwise follow, so a
// long-press never also triggers the element's tap action.

import { useCallback, useRef } from 'react'

const THRESHOLD_MS = 450
const MOVE_TOLERANCE_PX = 10

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onClickCapture: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}

export function useLongPress(onLongPress: () => void): LongPressHandlers {
  const timer = useRef<number | 0>(0)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const clear = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = 0
    origin.current = null
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    fired.current = false
    origin.current = { x: e.clientX, y: e.clientY }
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = 0
      fired.current = true
      onLongPress()
    }, THRESHOLD_MS)
  }, [onLongPress])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!origin.current) return
    const dx = e.clientX - origin.current.x
    const dy = e.clientY - origin.current.y
    if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) clear()
  }, [clear])

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    // A click always follows pointerup, even after a long-press — swallow
    // it so the press doesn't ALSO fire the element's tap action.
    if (fired.current) {
      e.preventDefault()
      e.stopPropagation()
      fired.current = false
    }
  }, [])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Mobile browsers open a context menu on long-press; that would fight
    // our gesture on the exact elements that define one.
    e.preventDefault()
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture,
    onContextMenu
  }
}
