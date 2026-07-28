// Reusable ticking countdown toward a Unix-seconds deadline. Re-renders
// once per second while visible; pauses when the document is hidden (a
// backgrounded WebView shouldn't burn timers) and snaps fresh on return.

import { useEffect, useState } from 'react'
import { EXPIRY_URGENT_S, EXPIRY_WARN_S, formatCountdown } from '../collectibles/tickets'

export interface Countdown {
  /** "5d 4h" · "20h" · "45m" · "<1m" · "expired" */
  label: string
  secondsLeft: number
  /** Under 24h — amber treatment. */
  warn: boolean
  /** Under 1h — red, pulsing treatment. */
  urgent: boolean
  expired: boolean
}

function compute(expiresAt: number): Countdown {
  const secondsLeft = Math.max(0, Math.floor(expiresAt - Date.now() / 1000))
  return {
    label: formatCountdown(expiresAt),
    secondsLeft,
    warn: secondsLeft > 0 && secondsLeft <= EXPIRY_WARN_S,
    urgent: secondsLeft > 0 && secondsLeft <= EXPIRY_URGENT_S,
    expired: secondsLeft <= 0
  }
}

export function useCountdown(expiresAt: number | undefined): Countdown | null {
  const [state, setState] = useState<Countdown | null>(
    expiresAt === undefined ? null : compute(expiresAt)
  )

  useEffect(() => {
    if (expiresAt === undefined) { setState(null); return }
    setState(compute(expiresAt))
    let id = 0
    const start = () => {
      if (id) return
      id = window.setInterval(() => setState(compute(expiresAt)), 1000)
    }
    const stop = () => { if (id) { window.clearInterval(id); id = 0 } }
    const onVisibility = () => {
      if (document.hidden) stop()
      else { setState(compute(expiresAt)); start() }
    }
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) start()
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [expiresAt])

  return state
}
