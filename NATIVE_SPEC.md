# Collectibles Catalogue Webview — Host Integration Spec

A single-page web app (built to one self-contained `index.html`) that a
host application embeds to show the user the collectibles (NFTs) they own.
The webview reads the user's owned NFTs and claim credits from chain
itself — through the **`@parity/product-sdk` host container** — resolves
each to a catalogue image, and presents an animated, swipeable gallery +
detail view.

> **The webview opens no sockets of its own inside a host.** All chain
> bytes flow through the product-sdk container (truapi transport); the
> host owns every connection. The former hand-rolled bridges — the
> `collectiblesChain` JSON-RPC proxy, `setCollection` / `pushNft` /
> `__COLLECTION__`, `setAccounts` / `__ACCOUNTS__`, `setPlayerIdentity` /
> `__PLAYER__` — were **removed 2026-08-13**. A legacy host that provides
> only the flow-event handler gets a shelf limited to the cached
> last-known collection (or the boot-timeout empty state): becoming a
> product-sdk container is what lights the shelf up.

---

## 0. TL;DR (Quick Reference)

### What the host must provide (product-sdk container)

| Capability | Detail |
|---|---|
| Chain: gamingnet Asset Hub | genesis `0x5c553ae24096d5402b86256773a96f80a68d2a713320767fd6480b8540f973e3` — served via `system.featureSupported` + the truapi `chain.*` domain (`chainHead_v1_*`-capable node) |
| Chain: gamingnet People | genesis `0x18640e58ac52e3a45921c7ac46e0d0143c80f9137b0ba9ae15be81f44b4909de` — **optional**: without it the shelf is owned-items-only, never an error |
| Product accounts | `account.getProductAccount(<dotNsIdentifier>, i)` for our DotNS identifier (see `src/chain/product.ts`) — index 0 is the player identity, indexes 0..n are the purse subtree the shelf scans |
| Flow events | a message handler named `collectibles` (unchanged, see §3) |
| Layout | WebView full-bleed, safe-area insets respected (§5) |

> **Both chain capabilities are probed, with TEMPORARY fallbacks** while
> no host build provides them: a host without product accounts gets the
> DEV_PHRASE dev derivation as the purse/identity stand-in, and a host
> that can't serve the gamingnet chains gets direct testnet sockets. Both
> fallbacks retire once real host builds answer — the seams
> (`purses.ts`, `client.ts`) are the swap points.

> A gamingnet **chain reset changes the genesis hashes** — the app's
> descriptors and every host build must re-sync before container mode
> works again. Drift surfaces as `ChainNotSupportedError`; the webview
> logs it and stops the sync for the session.

### What the webview reads (via the container's connections)

| Source | Yields |
|---|---|
| `Scarcity.NftsByOwner(purse)` per purse (product accounts by index, gap-limit scan) | the `Nft` value; `mintedAt` = its `minted_at` (Unix **seconds**) |
| `Scarcity.{Instance,Item,Collection}Metadata` (`"hash"`, `"n"`, `"i"` keys) | item identity hash, display name, artwork override (most specific level wins) |
| People `NftCredits` storage + `NftCreditsApi` runtime API | earned credits, shown as wrapped/pending items |
| Asset Hub `NftClaims.{CreditTrees,ClaimedCredits}` | splits credits into Earned / Claimable; claimed credits drop (their item arrives via the purse scan) |

### Events the host receives (register a handler named `collectibles`)

| `type` | Payload |
|---|---|
| `flow.ready` | — |
| `flow.gallery_shown` | `{ count }` |
| `flow.item_opened` | `{ hash }` |
| `flow.item_closed` | `{ hash }` |
| `flow.error` | `{ phase, detail? }` |
| `flow.close` *(reserved)* | — |

### Critical rules

- Identity is **per-hash**: two hashes that resolve to the same art are two
  distinct tiles. Claim-minted items without a hash key by instance id.
- An empty shelf is valid → empty state. Distinct from no poll landing
  (→ boot timeout after 8 s, `flow.error { phase: "boot_timeout" }`).
- The webview persists the last delivered collection per player and boots
  from it — offline sessions show the last-known shelf, not "empty".

---

## 1. Overview

The catalogue is an **owned-plus-earned gallery**: one tile per owned NFT,
plus wrapped tiles for credits not yet claimed. Tapping a tile opens an
animated detail view (shared-element zoom) with the artwork, name, mint
date, and full hash.

Flow:

1. The host loads `index.html` in its webview/container.
2. The webview resolves the player (product account 0), scans the purse
   subtree, reads credits, and renders — polling every 30 s.
3. The gallery mounts and runs its entrance → `flow.gallery_shown`.
4. User taps a collectible → detail view (`flow.item_opened`), swipes
   between items, closes back to the gallery (`flow.item_closed`).
5. The host owns dismissal (back gesture / native chrome).

If no data lands within **8 s**, the webview shows the cached or empty
state and emits `flow.error { phase: "boot_timeout" }` with
`detail: "showing_cached" | "no_cache"`.

---

## 2. Chain access — how the container serves it

The webview embeds `polkadot-api` with typed descriptors for the two
gamingnet chains and calls `createChainClient` from
`@parity/product-sdk-chain-client`. The SDK asks the host for each chain
by **genesis hash** (`system.featureSupported({ tag: "Chain", value:
{ genesisHash } })`) and proxies JSON-RPC over the truapi port. Nodes
behind the connections must support the modern `chainHead_v1_*` spec
(both gamingnet chains do).

**Purses & identity** come from host **product accounts**: the webview
requests `getProductAccount(<dotNsIdentifier>, i)` and treats index 0 as
the player (the credit-map identity) and indexes 0..n as the purse
subtree, scanned gap-limit style (batches of 10, stop after a fully-empty
trailing batch, occupied layout cached). The mint/claim pipeline must
deposit into the same product accounts by derivation index — this
replaces the dev `//nft//<i>` derivation inside a container (the two
schemes yield different addresses; open platform question until
ratified).

Errors during chain sync surface as `flow.error { phase: "chain",
detail }` and retry with exponential backoff (5 s → 60 s); a wedged
connection is torn down and rebuilt on the next poll.

---

## 3. Events transport (unchanged)

The webview posts events to the host, transport auto-detected in priority
order. **Register your handler under the name `collectibles`:**

1. **iOS (WKWebView):** `window.webkit.messageHandlers.collectibles.postMessage(obj)`
   — receives a JS object.
2. **Android:** `window.collectibles.postMessage(jsonString)` — register a
   `@JavascriptInterface` object named `collectibles` with a
   `postMessage(String)` method; receives a JSON string.
3. Fallback: `console.debug` (plain-browser dev — nothing to wire).

Detecting either handler (or the product-sdk container) also flips the
webview into **embedded mode** (§5).

All events are JSON-round-trip-safe (no `Date`/`BigInt`/`undefined`).

| `type` | Payload | When |
|---|---|---|
| `flow.ready` | — | Once, after first paint. The event channel is listening. |
| `flow.gallery_shown` | `{ count: number }` | Gallery mounted + entrance ran. `count` = items shown. |
| `flow.item_opened` | `{ hash: string }` | Detail view shown — on open **and on each swipe**. `hash` is `0x`-prefixed. |
| `flow.item_closed` | `{ hash: string }` | Detail view closed back to the gallery. |
| `flow.error` | `{ phase, detail? }` | See phases below. |
| `flow.close` | — | **Reserved.** Not emitted by any built-in UI today — the host owns dismissal. |

### `flow.error` phases

- **`boot_timeout`** — no data within 8 s; `detail` reports
  `showing_cached` or `no_cache`.
- **`chain`** — a sync poll failed; `detail` is the error message. Retried
  with backoff automatically (except a host refusing Asset Hub, which is
  permanent for the session).
- **`assets`** — one or more catalogue images failed to load; `detail` is
  `image_failures=<n>`. Emitted as a debounced rollup, only when the
  failure count grows. **Most likely cause: expired Bulletin Chain testnet
  CIDs** (see §4). The running count is also readable at
  `window.__ASSET_FAILURES__`.
- **`collection_truncated`** — the shelf exceeded the 500-item render cap;
  `detail` is `dropped=<n>`.

---

## 4. Hash → image resolution (FYI — the host implements nothing)

For context only. The bundled `src/collectibles/cid_map.json` indexes the
catalogue images (uploaded to the Bulletin Chain). For each hash the
webview computes, deterministically:

- bytes **0–1** (uint16) → rarity roll; `< 7865` (~12%) selects the **rare**
  pool, else the normal pool. (7865 absorbs the retired Web3 Summit sticker
  band — see EVENT_EXCLUSIVES.md; do not change it.)
- bytes **2–3** (uint16) → image index, `mod poolSize`, into the
  lexicographically-sorted pool.

Items whose chain metadata carries an explicit image URL (`"i"` key)
bypass this and render that art directly.

> ⚠️ **Operational note:** Bulletin Chain *testnet* CIDs expire (~2 weeks).
> When art stops loading you'll see `flow.error { phase: "assets" }`; the
> fix is to re-upload via `~/git/CollectableHashResolver` and ship a
> regenerated `cid_map.json` in the bundle.

---

## 5. Embedding & safe areas

The webview renders **full-bleed by default** — it fills the entire
viewport. The centered "phone-frame" mockup (bezel + fake status bar) is a
**desktop-preview convenience only** (`(pointer: fine)` and min 720×720);
touch devices never see it.

Inside a product-sdk container, or when a `collectibles` handler is
detected, the webview sets `body.is-embedded`, which guarantees full-bleed
even on a desktop-sized host. Force it for testing with `?embed=1`.

The page sets `viewport-fit=cover` and the layout honors
`env(safe-area-inset-*)`. Lay the WebView out edge-to-edge under the
notch / home indicator.

---

## 6. Implementation Checklist (Host)

### Required (load-bearing)

- [ ] Run the app inside a **product-sdk host container** (truapi port).
- [ ] Serve **gamingnet Asset Hub** (genesis `0x5c553a…`) through the
      container's chain domain.
- [ ] Answer **`getProductAccount(<dotNsIdentifier>, i)`** for our DotNS
      identifier.
- [ ] Register a `collectibles` message handler to receive `flow.*` events.
- [ ] Lay out the WebView full-bleed with safe-area insets respected.

### Recommended (graceful degradation)

- [ ] Serve **gamingnet People** (genesis `0x18640e…`) — enables the
      earned-credits (wrapped items) leg.
- [ ] Handle `flow.error { phase: "assets" }` to detect expired catalogue
      CIDs.
- [ ] Provide a native back / dismiss affordance (the webview doesn't
      render one).

### Not required

- Reading any chain state, deriving any keys, or pushing any collection
  data — the webview does all reads itself through the container.

---

## 7. Out of Scope (Future)

- A "full collection with locked slots" / completion-% mode (current
  design is owned-only).
- Phase 2: claiming Claimable credits from the shelf (tx signing via the
  SDK's signer — will add host requirements when it lands).
- Sharing a collectible out (image export / deep link).
- A web-side dismiss button emitting `flow.close`.

---

## 8. Test Scenarios (no host required)

Outside any host, the webview falls back to direct WebSockets to the
gamingnet testnet and in-page DEV_PHRASE key derivation. Append query
params in any browser:

| Param | Effect |
|---|---|
| `?dev=1` | Dev panel: load mock collections, reload. |
| `?mock=<name>` | Auto-load a scenario on boot: `small`, `typical`, `collector`, `rare`, `pending`, `empty`. Disables chain sync. |
| `?player=<ss58 or dev name>` / `?alias=<0xhex32>` | Read this identity's shelf + credits. Works in EVERY mode, including inside a host: the override outranks the host identity, dev-held roots scan their DEV_PHRASE purse subtree, and if the host can't serve the gamingnet chains the session falls back to direct testnet sockets. Dev names (`bob`, `zack`, …) expand to their DEV_PHRASE roots. Persisted for reloads outside a host. |
| `?open=<n>` | Auto-open the nth tile's detail view. |
| `?embed=1` | Force embedded full-screen layout (chain layer inert, like a legacy host — unless a `?player=` override is present). |

Container mode without a real host build: use
`@parity/host-api-test-sdk`'s playwright fixture pointed at the gamingnet
RPC + genesis (see `docs/READ_PATH.md`).

---

## 9. Versioning Note

This contract is intentionally small: a product-sdk container serving two
chains + product accounts in, six event types out. If a future build needs
more, it will add new `flow.*` variants — never repurpose existing ones.
The shipped TypeScript types are the source of truth:
`src/collection/types.ts` (store shapes), `src/host/send.ts` (flow events) and
`src/chain/product.ts` (the DotNS identifier).
