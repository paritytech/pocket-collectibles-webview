// Bridge v2 request/response channel.
//
// Outbound: `sendBridgeRequest()` posts `request.*` commands to native over
// the same `collectibles` transport as flow events (see send.ts).
//
// Inbound: native answers by calling `window.deliverRequestUpdate(update)`
// — registered here at module load with the same buffer-or-deliver
// discipline as the collection channel, so a response arriving before the
// consuming component mounts is buffered per requestId and replayed on
// subscribe.
//
// PRODUCTION: the native side of this channel is the mobile app's
// CollectiblesBridge. On `request.mint` it presents the approval sheet
// (PGAS-sponsored — the user never sees a fee), builds merkle proofs as a
// backgroundable job, signs via the existing TransactionSigningHandler,
// submits to the Asset Hub claim pallet, and streams RequestUpdates back.
// After any terminal update that changed ownership it re-delivers the whole
// collection via setCollection — updates are UX feedback; setCollection is
// truth.

import type { BridgeRequest, RequestItemUpdate, RequestStatus, RequestUpdate } from './types'
import { postToNative } from './send'

type Listener = (update: RequestUpdate) => void

const STATUSES: readonly RequestStatus[] = [
  'received', 'awaitingApproval', 'building', 'submitted', 'inBlock', 'done', 'failed', 'rejected'
]

const listeners = new Map<string, Set<Listener>>()
// Updates that arrived before anyone subscribed to their requestId, replayed
// in order on subscribe. Native (or the mock) can answer faster than React
// mounts the ceremony overlay.
const buffered = new Map<string, RequestUpdate[]>()
const MAX_BUFFERED = 50

function normalizeHash(hash: unknown): string | null {
  if (typeof hash !== 'string') return null
  let h = hash.trim()
  if (!h) return null
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2)
  return h.toLowerCase()
}

/** Defensive coercion of a native payload into a clean RequestUpdate, or
 *  null if it's unusable. Unknown statuses are dropped (a newer native must
 *  never crash an older page — same rule as the rest of the bridge). */
function coerceUpdate(raw: unknown): RequestUpdate | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.requestId !== 'string' || !obj.requestId) return null
  if (typeof obj.status !== 'string' || !STATUSES.includes(obj.status as RequestStatus)) return null
  const update: RequestUpdate = { requestId: obj.requestId, status: obj.status as RequestStatus }
  if (typeof obj.progress === 'number' && Number.isFinite(obj.progress)) {
    update.progress = Math.min(1, Math.max(0, obj.progress))
  }
  if (typeof obj.reason === 'string' && obj.reason) update.reason = obj.reason
  if (typeof obj.recipient === 'string' && obj.recipient) update.recipient = obj.recipient
  if (Array.isArray(obj.items)) {
    const items: RequestItemUpdate[] = []
    for (const rawItem of obj.items) {
      if (!rawItem || typeof rawItem !== 'object') continue
      const it = rawItem as Record<string, unknown>
      const hash = normalizeHash(it.ticketHash)
      if (!hash) continue
      const status = it.status
      if (status !== 'pending' && status !== 'minted' && status !== 'failed') continue
      const item: RequestItemUpdate = { ticketHash: hash, status }
      const itemId = normalizeHash(it.itemId)
      if (itemId) item.itemId = itemId
      if (typeof it.reason === 'string' && it.reason) item.reason = it.reason
      items.push(item)
    }
    update.items = items
  }
  return update
}

// ---- Global registered at module load ------------------------------------

;(window as unknown as Record<string, unknown>).deliverRequestUpdate = (raw: unknown) => {
  const update = coerceUpdate(raw)
  if (!update) {
    console.warn('[requests] dropped malformed RequestUpdate', raw)
    return
  }
  const subs = listeners.get(update.requestId)
  if (subs && subs.size > 0) {
    for (const cb of subs) {
      try { cb(update) } catch { /* a listener throwing can't break the channel */ }
    }
    return
  }
  const queue = buffered.get(update.requestId) ?? []
  if (queue.length < MAX_BUFFERED) queue.push(update)
  buffered.set(update.requestId, queue)
}

/** Subscribe to updates for one request. Buffered updates that arrived
 *  before the subscription are replayed immediately, in order. Returns an
 *  unsubscribe function; unsubscribing the last listener drops the buffer. */
export function subscribeRequestUpdates(requestId: string, cb: Listener): () => void {
  let subs = listeners.get(requestId)
  if (!subs) { subs = new Set(); listeners.set(requestId, subs) }
  subs.add(cb)
  const queue = buffered.get(requestId)
  if (queue) {
    buffered.delete(requestId)
    for (const update of queue) {
      try { cb(update) } catch { /* see above */ }
    }
  }
  return () => {
    const set = listeners.get(requestId)
    if (!set) return
    set.delete(cb)
    if (set.size === 0) { listeners.delete(requestId); buffered.delete(requestId) }
  }
}

/** Post a bridge v2 command to native. Fire-and-forget at the transport
 *  level; the answer arrives via deliverRequestUpdate. */
export function sendBridgeRequest(req: BridgeRequest): void {
  postToNative(req)
}

/** Fresh id for correlating a request with its update stream. Unique per
 *  page session is all the correlation needs. */
export function newRequestId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let id = 'req-'
  for (let i = 0; i < bytes.length; i++) id += bytes[i]!.toString(16).padStart(2, '0')
  return id
}
