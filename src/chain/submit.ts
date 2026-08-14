// Sign, submit and watch one extrinsic — shared by every write the app
// makes (the mint claim, chain/claim.ts; the send transfer,
// chain/transfer.ts). Settles as soon as the tx is IN A BLOCK rather than
// waiting out finality, and never rejects.

import type { PolkadotSigner } from 'polkadot-api/signer'

/** Coarse progress of a submission, for an overlay's status line. */
export type SubmitStatus = 'signing' | 'inBlock' | 'finalized'

export interface SubmitResult {
  ok: boolean
  /** A human-readable reason when `ok` is false. */
  error?: string
}

/** Read the nested dispatch error into a readable path, e.g.
 *  "Module · Scarcity · AddressOccupied". */
export function dispatchErrorText(err: { type: string; value: unknown } | undefined): string {
  const parts: string[] = []
  let cur: unknown = err
  while (cur && typeof cur === 'object' && 'type' in cur && typeof (cur as { type: unknown }).type === 'string') {
    const node = cur as { type: string; value?: unknown }
    parts.push(node.type)
    cur = node.value
  }
  return parts.join(' · ') || 'the transaction failed on-chain'
}

/** The minimal surface of a papi tx this module watches — anything with a
 *  `signSubmitAndWatch` yielding the standard TxEvent stream. The optional
 *  second arg forwards papi tx options (tip, mortality, and — for the send
 *  transfer — `customSignedExtensions`). */
interface WatchableTx {
  signSubmitAndWatch(signer: PolkadotSigner, options?: unknown): {
    subscribe(observer: {
      next: (event: TxWatchEvent) => void
      error: (err: unknown) => void
    }): { unsubscribe: () => void }
  }
}

// The subset of the papi TxEvent stream this module reads. Flat (not a
// discriminated union) so `type` can be compared against several tags while
// the outcome fields stay accessible.
interface TxWatchEvent {
  type: string
  found?: boolean
  ok?: boolean
  dispatchError?: { type: string; value: unknown }
}

/** Sign, submit, and watch `tx` to in-block inclusion. Resolves once —
 *  never rejects — with `ok` and, on failure, a reason. `onStatus` reports
 *  coarse progress for the UI.
 *
 *  Settles as soon as the tx is IN A BLOCK (~6–12s on this testnet), not on
 *  finality (~20–60s): the best-block state already carries the dispatch
 *  outcome. A reorg is rare here and self-corrects on the next poll;
 *  `finalized` stays a safety net in case best-block state is ever skipped. */
export function watchSubmission(
  tx: WatchableTx,
  signer: PolkadotSigner,
  onStatus: (status: SubmitStatus) => void,
  options?: unknown
): Promise<SubmitResult> {
  return new Promise<SubmitResult>((resolve) => {
    onStatus('signing')
    let settled = false
    const done = (result: SubmitResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const sub = tx.signSubmitAndWatch(signer, options).subscribe({
      next: (event) => {
        if (event.type === 'txBestBlocksState' && event.found) {
          onStatus('inBlock')
          done(event.ok ? { ok: true } : { ok: false, error: dispatchErrorText(event.dispatchError) })
          sub.unsubscribe()
        } else if (event.type === 'finalized') {
          done(event.ok ? { ok: true } : { ok: false, error: dispatchErrorText(event.dispatchError) })
          sub.unsubscribe()
        }
      },
      error: (err: unknown) => {
        done({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  })
}
