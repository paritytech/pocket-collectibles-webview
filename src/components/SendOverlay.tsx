import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import type { RequestStatus } from '../bridge/types'
import { subscribeRequestUpdates } from '../bridge/requests'
import { sendFlowEvent } from '../bridge/send'
import type { CollectibleEntry } from '../collectibles/format'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface SendOverlayProps {
  requestId: string
  /** Snapshot of the item being sent — it will vanish from the collection
   *  underneath when the truth delivery lands. */
  entry: CollectibleEntry
  /** The username picked in the recipient sheet (native may still correct
   *  it via the update stream). */
  recipient?: string
  onDone: () => void
}

// Player-world copy only (no crypto vocabulary). While 'awaitingApproval'
// is showing, PRODUCTION native has its approval sheet up over the
// WebView — the page just waits underneath.
const STATUS_COPY: Partial<Record<RequestStatus, string>> = {
  received: 'Starting…',
  awaitingApproval: 'Confirm to send',
  submitted: 'On its way…',
  inBlock: 'Almost there…'
}

const WATCHDOG_MS = 20_000

/** Send flow feedback: the item's card lifts off, waits for the (native)
 *  recipient pick, then flies away when the transfer lands. */
export default function SendOverlay({ requestId, entry, recipient: initialRecipient, onDone }: SendOverlayProps) {
  const reduce = useMemo(() => prefersReducedMotion(), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<RequestStatus>('received')
  const [recipient, setRecipient] = useState<string | null>(initialRecipient ?? null)
  const [stalled, setStalled] = useState(false)
  const flownRef = useRef(false)

  useEffect(() => {
    let watchdog = 0
    const arm = () => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(() => {
        setStalled(true)
        sendFlowEvent({ type: 'flow.error', phase: 'send_timeout', detail: requestId })
      }, WATCHDOG_MS)
    }
    arm()
    const off = subscribeRequestUpdates(requestId, (update) => {
      arm()
      setStatus(update.status)
      if (update.recipient) setRecipient(update.recipient)
      if (update.status === 'done' || update.status === 'failed' || update.status === 'rejected') {
        window.clearTimeout(watchdog)
      }
    })
    return () => { off(); window.clearTimeout(watchdog) }
  }, [requestId])

  // Entrance: the card floats up into the sending state.
  useEffect(() => {
    if (reduce) return
    const ctx = gsap.context(() => {
      gsap.from('.sendo-scrim', { opacity: 0, duration: 0.3, ease: EASE.entranceSoft })
      gsap.from(cardRef.current, { y: 60, scale: 0.8, opacity: 0, duration: 0.5, ease: EASE.settleSoft })
    }, rootRef)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The goodbye: on success the card sails off the top of the screen.
  useEffect(() => {
    if (status !== 'done' || flownRef.current) return
    flownRef.current = true
    haptic.play('badge-land')
    if (reduce || !cardRef.current) return
    gsap.to(cardRef.current, {
      y: -420, rotation: 8, opacity: 0,
      duration: 0.7, ease: EASE.exit, delay: 0.35
    })
  }, [status, reduce])

  const terminal = status === 'done' || status === 'failed' || status === 'rejected' || stalled
  const failed = status === 'failed' || status === 'rejected' || stalled

  return (
    <div className="sendo" ref={rootRef} role="dialog" aria-modal="true" aria-label="Send collectible">
      <div className="sendo-scrim" aria-hidden="true" />
      <div className="sendo-stage">
        <div className="sendo-card" ref={cardRef} style={{ '--glow': entry.resolved.glow } as React.CSSProperties}>
          <img src={entry.resolved.url} alt="" draggable={false} />
          <span className="sendo-card-name">{entry.resolved.name}</span>
        </div>

        <div className="sendo-status" role="status">
          {!terminal && (
            <span className="sendo-status-text">
              {status === 'submitted' && recipient
                ? `On its way to ${recipient}…`
                : STATUS_COPY[status] ?? '…'}
            </span>
          )}
          {status === 'done' && (
            <span className="sendo-status-text sendo-status-text--good">
              {recipient ? `Sent to ${recipient} ✓` : 'Sent ✓'}
            </span>
          )}
          {failed && status !== 'done' && (
            <span className="sendo-status-text">
              {status === 'rejected' ? 'Send cancelled — still yours.' : "That didn't go through — still yours."}
            </span>
          )}
          {terminal && (
            <button type="button" className="ceremony-done-btn" onClick={() => { haptic.play('tap-store'); onDone() }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
