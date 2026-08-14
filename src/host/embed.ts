// Two grades of "inside something":
//
// isInContainer — a product-sdk host container (truapi message port
// present). Chain connections, purse accounts and identity all come from
// the SDK; nothing else is trusted.
//
// isEmbedded — ANY native host: a container, a legacy WebView that only
// implements the 'collectibles' flow-event handler, or a ?embed=1 dev
// preview. Gates the things every host shares: App.tsx tags <body> so CSS
// flattens the phone-frame mockup, dev-name expansion is disabled, and a
// direct dev WebSocket is never opened (a legacy host without the SDK
// gets an INERT chain layer — cache or boot-timeout only — by design).

import { isInsideContainerSync } from '@parity/product-sdk-host'

export const isInContainer =
  typeof window !== 'undefined' && isInsideContainerSync()

export const isEmbedded =
  typeof window !== 'undefined' && (
    isInContainer ||
    !!(window as unknown as { collectibles?: unknown }).collectibles ||
    !!window.webkit?.messageHandlers?.collectibles ||
    /[?&]embed=1\b/.test(window.location.search)
  )
