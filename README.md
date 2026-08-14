> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

<div align="center">

# Collectibles Catalogue

*A prototype animated gallery for the collectibles a user owns — every NFT resolved to its artwork and presented as a swipeable, glowing collection, embedded as a WebView in a native mobile app.*

![Platform](https://img.shields.io/badge/WebView-iOS%20%C2%B7%20Android-5163f5?style=flat)
![Build](https://img.shields.io/badge/build-single--file%20index.html-2c25b0?style=flat)

<!-- TODO: hero screenshot — capture the gallery + a detail view (see "Screenshots" below) -->

</div>

---

This is a prototype. The native app reads the user's owned NFTs from the chain and hands the webview a list of 32-byte hashes. From the hash alone, the catalogue derives each item's artwork and rarity, then renders an animated grid you can sort, tap into for a full-screen detail view, and swipe between. There's no backend — the whole experience is a single self-contained `index.html` driven entirely by data passed over the native bridge.

## Features

- **Art from the hash alone** — Each item's image and rarity are derived deterministically from its 32-byte hash, so native sends only hashes — no metadata, names, or image URLs to wire up.
- **Color-matched glow** — Every collectible floats in an ethereal space on a saturated glow sampled from its own pixels; rare pulls burn brighter. No drop shadows — items read as light, not stickers.
- **Cinematic detail view** — Tapping a tile runs a shared-element zoom into a full-screen hero, with rotating light rays and a surface shimmer reserved for rare items, plus swipe-to-browse.
- **Animated gallery** — A staggered entrance, a rolling owned-count tally, and instant sorting by Newest, Rarity, or Name.
- **Duplicate stacking** — Multiple copies of the same asset collapse into one tile with a small `×N` badge instead of cluttering the grid.
- **Drop-in WebView** — Builds to one inlined `index.html` (no server, no external asset paths) for trivial hosting inside an iOS or Android WebView.
- **Resilient bridge** — Tolerates malformed, oversized, and streamed native payloads (field validation, a 500-item cap, coalesced updates) and degrades gracefully: a boot timeout falls back to an empty state, and image failures report back as telemetry.
- **Native-feel polish** — Haptics on interaction, safe-area insets honored under the notch, and full `prefers-reduced-motion` support.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5174
npm run build      # → dist/index.html  (one self-contained file)
npm run typecheck
```

<details>
<summary>Prerequisites</summary>

- Node.js 20+

</details>

## Try it without native

The webview runs in any browser using mock data — append a query parameter:

| Param | Effect |
|---|---|
| `?dev=1` | Show the dev panel to load mock collections on demand (includes the **+ pending** and **+ duplicates** scenarios). |
| `?mock=<name>` | Auto-load a scenario on boot: `small`, `typical`, `collector`, `rare`, or `empty`. |
| `?open=<n>` | Auto-open the nth tile's detail view. |
| `?embed=1` | Force the embedded full-screen layout (skips the desktop phone-frame preview). |

```
http://localhost:5174/?mock=collector&embed=1
```

### Screenshots

This is a visual app and the README should lead with a hero shot. None are captured yet — to add them, run a populated scenario and capture:

```
http://localhost:5174/?mock=collector&embed=1   # the gallery
http://localhost:5174/?mock=rare&open=0&embed=1  # a rare item's detail view
```

Save to `assets/screenshots/` (e.g. `gallery.png`, `detail-rare.png`) and drop them into the header block and the relevant sections.

## Native integration

Native delivers the owned set and receives lifecycle events over a small bridge:

```js
// Deliver the whole owned set (call any time), or pre-set it before the bundle runs:
window.setCollection({ owned: [{ hash, mintedAt }, …], displayName })
window.__COLLECTION__ = { owned: [ … ], displayName }

// …or stream items in one at a time:
window.pushNft({ hash, mintedAt })
```

The webview posts `flow.*` events back (ready, gallery shown, item opened/closed, errors) to a handler named `collectibles`. **[NATIVE_SPEC.md](./NATIVE_SPEC.md)** is the full contract — payload schema, event types, lifecycle, and the chain reads native must perform.

## How it works

- **Bridge** (`src/bridge/`) — Globals registered at module load buffer whatever native sends, before or after React mounts. Input is validated and capped; a burst of streamed items is coalesced into one render. `sendFlowEvent` posts events back to native.
- **Resolver** (`src/collectibles/resolver.ts`) — Maps a 32-byte hash to a catalogue image via the bundled `cid_map.json`: bytes 0–1 roll rarity, bytes 2–3 pick the image from the matching pool. Artwork is served from a Bulletin Chain IPFS gateway.
- **Gallery** (`src/screens/GalleryScreen.tsx`) — The grid, entrance animation, sorting, and duplicate collapsing.
- **Detail** (`src/screens/DetailScreen.tsx`) — The shared-element zoom, rare flourishes, and swipe navigation.
- **Particles** (`src/particles/`) — A small Canvas 2D engine for the ambient field and reveal bursts.

Stack: React 18 + TypeScript + Vite, bundled with `vite-plugin-singlefile`; animation via GSAP.

<details>
<summary>Operational note: catalogue artwork</summary>

Bulletin Chain **testnet** CIDs expire (~2 weeks). When artwork stops loading the webview emits `flow.error { phase: "assets" }`; the fix is to re-upload the catalogue and regenerate `src/collectibles/cid_map.json`. This is a build-time concern — the webview never reads the chain itself.

</details>

## Hosting the build

`npm run build` produces a single static `dist/index.html` you can host
anywhere — a web server, object storage, or content-addressed storage
such as the Polkadot Bulletin Chain bound to a DotNS `.dot` name.

## Security

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself, we publish a reference, not a hardened production build
- Checking that the dependencies are up to date and free of known vulnerabilities
- Securing your own fork or deployment environment (keys, secrets, network configuration)
- Tracking the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and Bug Bounty program, feel free to visit: https://parity.io/bug-bounty

## License

[MIT](./LICENSE) © Parity Technologies
