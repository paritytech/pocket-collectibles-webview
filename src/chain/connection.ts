// Where chain bytes come from — for BOTH chains.
//
// The shelf is assembled from two chains (design doc §3, "the read path"):
//   - People Chain: the credit map (what the player earned)
//   - Asset Hub:    NftsByOwner + metadata (what is minted, and where)
//
/*
* TEMPORARY SOLUTION TO OPEN QUESTION
* NO DEPENDENCY NUMBER (not in the table yet)
* https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
*
* The host chain-provider bridge is proposed in NATIVE_SPEC.md §11 and
* needs native sign-off; the direct-WebSocket dev fallback below is the
* agreed interim way to start.
*
*/
//
// Production rule: the HOST supplies every chain connection — the webview
// opens no sockets of its own. This module owns that seam. Until hosts
// implement it, a non-embedded dev build falls back to direct WebSockets
// to the gaming testnet, and an embedded host WITHOUT the seam gets no
// provider at all: the chain layer stays inert and the legacy push bridge
// (setCollection/pushNft) keeps feeding the gallery.
//
// Proposed host transport (mirrors the flow-event bridge in send.ts;
// to be agreed with native — see NATIVE_SPEC.md §11). Every message names
// its chain, so one bridge multiplexes both connections:
//   web -> native  window.webkit.messageHandlers.collectiblesChain
//                    .postMessage(jsonString)                    (iOS)
//                  window.collectiblesChain.postMessage(jsonString) (Android)
//                  where jsonString = {"chain":"assetHub"|"people","msg":<JSON-RPC>}
//   native -> web  window.onChainRpcMessage(chain, jsonString)
//                  where jsonString = <JSON-RPC response/notification>
// Strings cross the WebView boundary; polkadot-api speaks structured
// JSON-RPC objects, so this adapter (de)serializes at the seam.

import type { JsonRpcProvider } from 'polkadot-api'
import { getWsProvider } from 'polkadot-api/ws'
import { isEmbedded } from '../bridge/embed'

export type ChainId = 'assetHub' | 'people'

/** Corey's gaming testnet endpoints. Dev fallback only. */
export const TESTNET_WS: Record<ChainId, string> = {
  assetHub: 'wss://gamingnet.substrate.dev/asset-hub', // spec: next-asset-hub-paseo
  people: 'wss://gamingnet.substrate.dev/people' // spec: Individuality Local
}

const CHAIN_BRIDGE_NAME = 'collectiblesChain'
// Host messages arriving before polkadot-api connects are buffered per
// chain (bounded — same discipline as the request-update channel).
const MAX_BUFFERED = 50

type OnMessage = Parameters<JsonRpcProvider>[0]
type JsonRpcMessage = Parameters<OnMessage>[0]

// ---- native -> web, buffer-or-deliver, registered at module load --------

interface ChainInbox {
  deliver: OnMessage | null
  buffered: JsonRpcMessage[]
}
const inboxes: Record<ChainId, ChainInbox> = {
  assetHub: { deliver: null, buffered: [] },
  people: { deliver: null, buffered: [] }
}

;(window as unknown as Record<string, unknown>).onChainRpcMessage = (
  chain: string,
  json: string
) => {
  const inbox = inboxes[chain as ChainId]
  if (!inbox) {
    console.warn('[chain] host sent JSON-RPC for unknown chain', chain)
    return
  }
  let msg: JsonRpcMessage
  try {
    msg = JSON.parse(json) as JsonRpcMessage
  } catch {
    console.warn('[chain] host sent unparseable JSON-RPC message')
    return
  }
  if (inbox.deliver) inbox.deliver(msg)
  else if (inbox.buffered.length < MAX_BUFFERED) inbox.buffered.push(msg)
}

// ---- web -> native transport, resolved at call time ----------------------

function hostTransport(): ((json: string) => void) | null {
  const ios = window.webkit?.messageHandlers?.[CHAIN_BRIDGE_NAME]
  if (ios && typeof ios.postMessage === 'function') {
    return (json) => ios.postMessage(json)
  }
  const android = (window as unknown as Record<string, unknown>)[CHAIN_BRIDGE_NAME] as
    | { postMessage?: (s: string) => void }
    | undefined
  if (android && typeof android.postMessage === 'function') {
    return (json) => android.postMessage!(json)
  }
  return null
}

function hostProvider(chain: ChainId, post: (json: string) => void): JsonRpcProvider {
  return (onMessage) => {
    const inbox = inboxes[chain]
    inbox.deliver = onMessage
    while (inbox.buffered.length > 0) onMessage(inbox.buffered.shift()!)
    return {
      send: (msg) => post(JSON.stringify({ chain, msg })),
      disconnect: () => {
        if (inbox.deliver === onMessage) inbox.deliver = null
      }
    }
  }
}

/** The connection for `chain` this session, or null when there is none
 *  (embedded host without the chain seam — chain layer must stay inert). */
export function getChainProvider(chain: ChainId): JsonRpcProvider | null {
  const post = hostTransport()
  if (post) return hostProvider(chain, post)
  if (!isEmbedded) return getWsProvider(TESTNET_WS[chain])
  return null
}
