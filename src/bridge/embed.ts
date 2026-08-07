// "Embedded" = running inside a native WebView host (not a desktop
// preview). Shared definition: App.tsx tags <body> with it so CSS
// flattens the phone-frame mockup; the chain provider uses it to decide
// whether a direct dev WebSocket is allowed (never inside a host).

export const isEmbedded =
  typeof window !== 'undefined' && (
    !!(window as unknown as { collectibles?: unknown }).collectibles ||
    !!window.webkit?.messageHandlers?.collectibles ||
    /[?&]embed=1\b/.test(window.location.search)
  )
