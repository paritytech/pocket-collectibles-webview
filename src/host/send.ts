// Web→native event channel. Mirrors the game-results webview's
// conventions.
//
// Picks a transport at runtime, in priority order:
//   1. window.webkit.messageHandlers.collectibles  (iOS WKWebView)
//   2. window.collectibles with a postMessage(json)  (Android pattern)
//   3. console.debug fallback (dev / plain browser)

// Web→native events. The host may ignore any of these; they exist for
// telemetry, native chrome (e.g. a back button), and lifecycle.
export type FlowEvent =
  /** Fired once after first paint — the webview is alive and listening. */
  | { type: 'flow.ready' }
  /** The gallery has mounted and run its entrance. */
  | { type: 'flow.gallery_shown'; count: number }
  /** User opened a collectible's detail view. */
  | { type: 'flow.item_opened'; hash: string }
  /** User closed the detail view, back to the gallery. */
  | { type: 'flow.item_closed'; hash: string }
  /** Webview-side error worth surfacing for telemetry. `phase` identifies
   *  the area (e.g. 'boot_timeout', 'assets'); `detail` is optional. */
  | { type: 'flow.error'; phase: string; detail?: string }
  /** User opened the mint flow for a claimable credit. */
  | { type: 'flow.mint_opened'; hash: string }
  /** A collection's preview was shown for the credit. */
  | { type: 'flow.mint_previewed'; hash: string; collection: number }
  /** User confirmed and the claim was submitted. */
  | { type: 'flow.mint_submitted'; hash: string; collection: number }
  /** The claim finalised — `success` false carries a `detail` reason. */
  | { type: 'flow.mint_result'; hash: string; success: boolean; detail?: string }
  /** User asked to dismiss the webview (e.g. tapped the close affordance).
   *  The host should tear down the WebView. */
  | { type: 'flow.close' }

const HANDLER_NAME = 'collectibles'

interface IOSBridge { postMessage(payload: unknown): void }
interface AndroidBridge { postMessage(payload: string): void }

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, IOSBridge | undefined> }
  }
}

export function sendFlowEvent(event: FlowEvent): void {
  try {
    // Dev-only: assert the event survives a JSON round-trip cleanly, so
    // future event variants that accidentally carry non-serializable
    // fields (Date, BigInt, undefined) are caught before they manifest
    // as an Android-only bug. Production behavior unchanged.
    if (import.meta.env.DEV) {
      try {
        const round = JSON.parse(JSON.stringify(event))
        if (round?.type !== event.type) {
          console.warn('[host] event lost type field after round-trip', event)
        }
      } catch (rtErr) {
        console.warn('[host] event failed JSON round-trip', event, rtErr)
      }
    }

    const ios = window.webkit?.messageHandlers?.[HANDLER_NAME]
    if (ios && typeof ios.postMessage === 'function') {
      ios.postMessage(event)
      return
    }
    const android = (window as unknown as Record<string, unknown>)[HANDLER_NAME] as AndroidBridge | undefined
    if (android && typeof android.postMessage === 'function') {
      android.postMessage(JSON.stringify(event))
      return
    }
    if (typeof console !== 'undefined') {
      console.debug('[host]', event)
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[host] send failed', err)
    }
  }
}
