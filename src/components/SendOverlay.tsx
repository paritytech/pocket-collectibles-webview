import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CollectibleEntry } from '../collectibles/format'
import {
  loadSendRecipients,
  sendItem,
  type SendRecipient,
  type SendStatus
} from '../chain/transfer'
import { sendFlowEvent } from '../host/send'
import { haptic } from '../haptics/engine'
import SearchableSelect from './SearchableSelect'

// The send flow: for an owned item, pick a recipient from a dropdown and
// transfer the NFT to a purse in their subtree (so it lands on their shelf).
// Recipients are the well-known dev accounts for now — how players address one
// another is still open (dependency #2/#3), and we send between dev accounts.
// Portaled into .phone-frame like the mint overlay, and reuses its frosted
// overlay shell classes (mint-overlay / mint-card / mint-btn …).

type Phase = 'picking' | 'submitting' | 'sent' | 'failed'

interface SendOverlayProps {
  /** An owned item — carries hashHex (the item identity) and resolved art. */
  entry: CollectibleEntry
  onClose: () => void
}

const SENT_HOLD_MS = 1500

function statusLabel(status: SendStatus | null): string {
  switch (status) {
    case 'signing': return 'Confirming…'
    case 'inBlock': return 'Sending…'
    case 'finalized': return 'Almost there…'
    default: return 'Working…'
  }
}

export default function SendOverlay({ entry, onClose }: SendOverlayProps) {
  const [phase, setPhase] = useState<Phase>('picking')
  const [recipients] = useState<SendRecipient[]>(() => loadSendRecipients())
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<SendStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const closedRef = useRef(false)

  useEffect(() => {
    sendFlowEvent({ type: 'flow.send_opened', hash: entry.hashHex })
  }, [entry.hashHex])

  const busy = phase === 'submitting'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  function close(): void {
    if (closedRef.current) return
    closedRef.current = true
    onClose()
  }

  const options = useMemo(
    () => recipients.map((r) => ({ value: r.rootPath, label: r.name })),
    [recipients]
  )
  const selected = recipients.find((r) => r.rootPath === selectedRoot) ?? null
  const canConfirm = phase === 'picking' && selectedRoot !== null

  async function confirm(): Promise<void> {
    if (!canConfirm || selectedRoot === null) return
    haptic.play('tap-view')
    setError(null)
    setStatus('signing')
    setPhase('submitting')
    sendFlowEvent({ type: 'flow.send_submitted', hash: entry.hashHex, to: selected?.name ?? selectedRoot })
    const result = await sendItem(
      { hash: entry.hashHex, recipientRoot: selectedRoot },
      (s) => setStatus(s)
    )
    if (result.ok) {
      sendFlowEvent({ type: 'flow.send_result', hash: entry.hashHex, success: true })
      haptic.play('legendary-reveal')
      setPhase('sent')
      window.setTimeout(close, SENT_HOLD_MS)
    } else {
      sendFlowEvent({ type: 'flow.send_result', hash: entry.hashHex, success: false, detail: result.error })
      setError(result.error ?? 'The transfer didn’t go through.')
      setPhase('failed')
    }
  }

  const sent = phase === 'sent'
  const artUrl = entry.resolved.url

  const card = (
    <div
      className="mint-overlay"
      role="presentation"
      onClick={() => { if (!busy) close() }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="mint-card"
        role="dialog"
        aria-modal="true"
        aria-label="Send your collectible"
        onClick={(e) => e.stopPropagation()}
      >
        {!busy && (
          <button type="button" className="mint-close" onClick={close} aria-label="Close">×</button>
        )}

        <h2 className="mint-title">
          {sent ? 'Sent!' : phase === 'submitting' ? 'Sending…' : 'Send your collectible'}
        </h2>

        <div className="send-preview">
          <img className="send-preview-art" src={artUrl} alt={entry.resolved.name} draggable={false} />
        </div>

        {sent ? (
          <p className="mint-copy mint-copy--reveal">
            {selected ? `On its way to ${selected.name}` : 'On its way'}
          </p>
        ) : phase === 'submitting' ? (
          <p className="mint-copy" role="status">{statusLabel(status)}</p>
        ) : (
          <>
            <p className="mint-copy">Choose who to send <strong>{entry.resolved.name}</strong> to.</p>
            {recipients.length === 0 ? (
              <p className="mint-error" role="alert">No one to send to right now.</p>
            ) : (
              <SearchableSelect
                options={options}
                value={selectedRoot}
                onChange={setSelectedRoot}
                placeholder="Choose a recipient"
                searchPlaceholder="Search accounts…"
                ariaLabel="Choose a recipient"
              />
            )}
            {error && <p className="mint-error" role="alert">{error}</p>}
          </>
        )}

        {!busy && !sent && (
          <div className="mint-actions">
            <button type="button" className="mint-btn mint-btn--ghost" onClick={close}>
              {phase === 'failed' ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className="mint-btn mint-btn--primary"
              disabled={!canConfirm}
              onClick={() => void confirm()}
            >
              {phase === 'failed' ? 'Try again' : 'Send it'}
            </button>
          </div>
        )}
      </div>
    </div>
  )

  const target = typeof document !== 'undefined'
    ? (document.querySelector('.phone-frame') as HTMLElement | null)
    : null
  return target ? createPortal(card, target) : card
}
