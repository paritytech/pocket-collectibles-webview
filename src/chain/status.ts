// Whether the chain sync is healthy — the one bit the UI needs to tell
// "empty shelf" apart from "can't reach the chains". Set by the poll loop
// (start.ts), read by App.tsx.
//
//   idle  — no sync this session (legacy embedded host, ?mock= session)
//   ok    — the last poll delivered
//   error — the last poll failed; the loop is retrying with backoff

import { createObservable } from '../lib/observable'

export type ChainSyncStatus = 'idle' | 'ok' | 'error'

const status = createObservable<ChainSyncStatus>('idle')

export function setChainSyncStatus(next: ChainSyncStatus): void {
  status.set(next)
}

/** Calls cb immediately with the current status, then on every change.
 *  Returns an unsubscribe function. */
export function subscribeChainSyncStatus(cb: (status: ChainSyncStatus) => void): () => void {
  return status.subscribe(cb)
}
