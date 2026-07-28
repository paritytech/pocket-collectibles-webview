// Web→native event channel.
//
// Picks a transport at runtime, in priority order:
//   1. window.webkit.messageHandlers.collectibles  (iOS WKWebView)
//   2. window.collectibles with a postMessage(json)  (Android pattern)
//   3. console.debug fallback (dev / plain browser)

import type { FlowEvent } from './types'

const BRIDGE_NAME = 'collectibles'

interface IOSBridge { postMessage(payload: unknown): void }
interface AndroidBridge { postMessage(payload: string): void }

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, IOSBridge | undefined> }
  }
}

/** Post any payload to native over the detected transport. Shared by
 *  `sendFlowEvent` (telemetry) and `sendBridgeRequest` (bridge v2 commands,
 *  see requests.ts) so there is exactly one transport implementation. */
export function postToNative(payload: { type: string }): void {
  try {
    // Dev-only: assert the payload survives a JSON round-trip cleanly, so
    // future variants that accidentally carry non-serializable fields
    // (Date, BigInt, undefined) are caught before they manifest as an
    // Android-only bug. Production behavior unchanged.
    if (import.meta.env.DEV) {
      try {
        const round = JSON.parse(JSON.stringify(payload))
        if (round?.type !== payload.type) {
          console.warn('[bridge] payload lost type field after round-trip', payload)
        }
      } catch (rtErr) {
        console.warn('[bridge] payload failed JSON round-trip', payload, rtErr)
      }
    }

    const ios = window.webkit?.messageHandlers?.[BRIDGE_NAME]
    if (ios && typeof ios.postMessage === 'function') {
      ios.postMessage(payload)
      return
    }
    const android = (window as unknown as Record<string, unknown>)[BRIDGE_NAME] as AndroidBridge | undefined
    if (android && typeof android.postMessage === 'function') {
      android.postMessage(JSON.stringify(payload))
      return
    }
    if (typeof console !== 'undefined') {
      console.debug('[bridge]', payload)
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[bridge] send failed', err)
    }
  }
}

export function sendFlowEvent(event: FlowEvent): void {
  postToNative(event)
}
