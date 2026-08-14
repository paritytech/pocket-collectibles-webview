import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CollectibleEntry } from '../collectibles/format'
import {
  loadMintCollections,
  loadMintPreviews,
  claimCredit,
  type MintCollection,
  type MintPreview,
  type ClaimStatus
} from '../chain/mint'
import { sendFlowEvent } from '../host/send'
import { haptic } from '../haptics/engine'
import ChipStrip from './ChipStrip'

// The mint flow: for a claimable credit, pick a collection to spend it on,
// see a BLURRED preview of the exact item that would mint (Random selection is
// deterministic, so the preview is the mint), switch collections freely, then
// confirm to claim it. On success the blur resolves and the shelf refreshes,
// the item now unwrapped. Portaled into .phone-frame like the other overlays.

type Phase = 'loading' | 'picking' | 'submitting' | 'revealing' | 'failed'

interface MintOverlayProps {
  /** A claimable credit — carries hashHex (the credit) and awardBlock. */
  entry: CollectibleEntry
  onClose: () => void
}

const REVEAL_HOLD_MS = 1700

function statusLabel(status: ClaimStatus | null): string {
  switch (status) {
    case 'signing': return 'Confirming…'
    case 'inBlock': return 'Revealing…'
    case 'finalized': return 'Almost there…'
    default: return 'Working…'
  }
}

export default function MintOverlay({ entry, onClose }: MintOverlayProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [collections, setCollections] = useState<MintCollection[]>([])
  const [previews, setPreviews] = useState<Map<number, MintPreview>>(new Map())
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<ClaimStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const closedRef = useRef(false)

  // Load the registered collections and their previews once.
  useEffect(() => {
    let alive = true
    sendFlowEvent({ type: 'flow.mint_opened', hash: entry.hashHex })
    void (async () => {
      try {
        const cols = await loadMintCollections()
        if (!alive) return
        if (cols.length === 0) {
          setLoadError('No collections are open for minting right now.')
          setPhase('picking')
          return
        }
        const pv = await loadMintPreviews(entry.hashHex, cols.map((c) => c.id))
        if (!alive) return
        const map = new Map<number, MintPreview>()
        pv.forEach((p) => map.set(p.collection, p))
        setCollections(cols)
        setPreviews(map)
        const firstMintable = cols.find((c) => map.get(c.id)?.outcome.kind === 'mints')
        setSelectedId((firstMintable ?? cols[0]).id)
        setPhase('picking')
      } catch (err) {
        if (!alive) return
        setLoadError(err instanceof Error ? err.message : 'Could not load the preview.')
        setPhase('picking')
      }
    })()
    return () => { alive = false }
  }, [entry.hashHex])

  const busy = phase === 'submitting' || phase === 'revealing'

  // Esc closes, but never mid-mint.
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

  function pick(id: number): void {
    if (busy) return
    haptic.play('tap-store')
    setSelectedId(id)
    setError(null)
    sendFlowEvent({ type: 'flow.mint_previewed', hash: entry.hashHex, collection: id })
  }

  const selected = selectedId !== null ? previews.get(selectedId) : undefined
  const mints = selected?.outcome.kind === 'mints' ? selected.outcome : null
  const canConfirm = phase === 'picking' && mints !== null && entry.awardBlock !== undefined

  async function confirm(): Promise<void> {
    if (!canConfirm || selectedId === null || entry.awardBlock === undefined) return
    haptic.play('tap-view')
    setError(null)
    setStatus('signing')
    setPhase('submitting')
    sendFlowEvent({ type: 'flow.mint_submitted', hash: entry.hashHex, collection: selectedId })
    const result = await claimCredit(
      { credit: entry.hashHex, awardBlock: entry.awardBlock, collection: selectedId },
      (s) => setStatus(s)
    )
    if (result.ok) {
      sendFlowEvent({ type: 'flow.mint_result', hash: entry.hashHex, success: true })
      haptic.play('legendary-reveal')
      setPhase('revealing')
      window.setTimeout(close, REVEAL_HOLD_MS)
    } else {
      sendFlowEvent({ type: 'flow.mint_result', hash: entry.hashHex, success: false, detail: result.error })
      setError(result.error ?? 'The mint didn’t go through.')
      setPhase('failed')
    }
  }

  const chips = collections.map((c) => ({
    id: c.id,
    label: c.name ?? `Collection ${c.id}`,
    disabled: previews.get(c.id)?.outcome.kind === 'fails'
  }))

  const revealed = phase === 'revealing'
  const artUrl = mints?.imageUrl

  const card = (
    <div
      className="mint-overlay"
      role="presentation"
      onClick={() => { if (!busy) close() }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className={`mint-card${revealed ? ' mint-card--revealed' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Mint your collectible"
        onClick={(e) => e.stopPropagation()}
      >
        {!busy && (
          <button type="button" className="mint-close" onClick={close} aria-label="Close">×</button>
        )}

        <h2 className="mint-title">
          {revealed ? 'It’s yours!' : phase === 'submitting' ? 'Revealing…' : 'Reveal your collectible'}
        </h2>

        {phase === 'loading' ? (
          <div className="mint-preview mint-preview--loading" aria-busy="true">
            <span className="mint-spinner" aria-hidden="true" />
          </div>
        ) : (
          <>
            <div className={`mint-preview${revealed ? ' mint-preview--revealed' : ''}`}>
              {artUrl ? (
                <img
                  className="mint-preview-art"
                  src={artUrl}
                  alt={revealed ? (mints?.name ?? 'Your collectible') : 'A blurred preview of your collectible'}
                  draggable={false}
                />
              ) : (
                <div className="mint-preview-placeholder" aria-hidden="true" />
              )}
              {!revealed && <div className="mint-preview-veil" aria-hidden="true" />}
            </div>

            {revealed ? (
              <p className="mint-copy mint-copy--reveal">{mints?.name ?? 'Added to your collection'}</p>
            ) : phase === 'submitting' ? (
              <p className="mint-copy" role="status">{statusLabel(status)}</p>
            ) : (
              <>
                <p className="mint-copy">
                  Pick a collection. You’ll see the shape, but not the details — until you reveal it.
                </p>
                {chips.length > 0 && (
                  <ChipStrip
                    items={chips}
                    selectedId={selectedId}
                    onSelect={pick}
                    ariaLabel="Choose a collection to mint from"
                  />
                )}
                {loadError && <p className="mint-error" role="alert">{loadError}</p>}
                {selected?.outcome.kind === 'fails' && !loadError && (
                  <p className="mint-error" role="alert">This collection can’t mint right now.</p>
                )}
                {error && <p className="mint-error" role="alert">{error}</p>}
              </>
            )}
          </>
        )}

        {!busy && !revealed && (
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
              {phase === 'failed' ? 'Try again' : 'Reveal it'}
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
