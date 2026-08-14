# Collectibles Catalogue Webview — Native Integration Spec

A single-page web app (built to one self-contained `index.html`) that the
native mobile app hosts in a WebView to show the user the collectibles
(NFTs) they own. The webview reads the user's owned NFTs from Asset Hub
itself (over a chain connection the host supplies — see §11), resolves each
to a catalogue image, and presents an animated, swipeable gallery + detail
view.

> **The webview opens no sockets of its own.** In production, chain bytes
> flow through the host-supplied JSON-RPC bridge (§11). A host that does
> not provide that bridge falls back to the legacy push model below: native
> reads the chain and pushes the owned set in, and the webview is a pure
> renderer over that data. Both paths feed the same store; last write wins.

---

## 0. TL;DR (Quick Reference)

### What gets read from the chain (per current user)

> Pallet reality check (verified against `pallet-scarcity` in polkadot-sdk
> and the gamingnet testnet): `Scarcity.NftsByOwner: AccountId -> Nft` is a
> **plain map** — every account holds at most ONE NFT (the "coinage"
> model), so the user's collection is a **list of purse addresses**, one
> item each. The earlier `Nfts(owner, *)` double-map description below the
> line is stale. The 32-byte `hash` is not in the `Nft` value; it lives in
> metadata under the key `"hash"`, resolved instance → item → collection.

| Source | Yields |
|---|---|
| `Scarcity.NftsByOwner(purse)` per purse address | the `Nft` value; `mintedAt` = its `minted_at` (Unix **seconds**) |
| `Scarcity.{Instance,Item,Collection}Metadata` key `"hash"` | the item's 32-byte identity `hash` (most specific level wins) |
| People Chain `Identity` username *(optional, push path only)* | `displayName` (e.g. `"byteboro.42"`) |

When the webview reads the chain itself (§11), native only supplies the
purse address list (`window.setAccounts` / `__ACCOUNTS__`) and the JSON-RPC
bridge. On the legacy push path, native performs the reads above and
delivers the result via `setCollection` as before.

### What native installs / calls (web side)

```js
// Deliver the whole owned set (replace). Call any time.
window.setCollection({ owned: [ { hash, mintedAt }, … ], displayName })

// OR pre-set the same object before the bundle's JS runs:
window.__COLLECTION__ = { owned: [ … ], displayName }

// OR stream items one at a time (upsert by hash):
window.pushNft({ hash, mintedAt })
```

### Events native receives (register a handler named `collectibles`)

| `type` | Payload |
|---|---|
| `flow.ready` | — |
| `flow.gallery_shown` | `{ count }` |
| `flow.item_opened` | `{ hash }` |
| `flow.item_closed` | `{ hash }` |
| `flow.error` | `{ phase, detail? }` |
| `flow.close` *(reserved)* | — |

### Critical rules

- `mintedAt` is **Unix seconds** (the raw `u32`), not milliseconds.
- Identity is **per-hash**: two hashes that resolve to the same art are two
  distinct tiles. De-dupe is by exact hash only.
- An **empty** `owned: []` is valid → empty state. Distinct from never
  delivering (→ boot timeout after 8 s).
- Everything except `displayName` comes from the two NFT maps; `displayName`
  is a separate People Chain query and is **optional** (graceful fallback).

---

## 1. Overview

The catalogue is an **owned-only gallery**: it shows exactly the NFTs the
user holds, one tile per NFT hash. There is no notion of "locked" or
"missing" slots. Tapping a tile opens an animated detail view (shared-element
zoom) with the artwork, rarity, mint date, and full hash.

Flow:

1. Native loads `index.html` in a WebView.
2. Native delivers the owned set (§3) — before or after the page's JS runs;
   the bridge buffers either way.
3. The gallery mounts and runs its entrance → `flow.gallery_shown`.
4. User taps a collectible → detail view (`flow.item_opened`), swipes between
   items, closes back to the gallery (`flow.item_closed`).
5. Native owns dismissal (back gesture / native chrome).

If no collection arrives within **8 s**, the webview shows the empty state
and emits `flow.error { phase: "boot_timeout" }`.

---

## 2. Chain data — what native must read

This is the entire chain surface the catalogue depends on. Two storage maps
provide everything except the optional username.

### 2.1 `Nfts` — confirmed mints (required)

```rust
// (owner, NFT hash) -> u32 unix-seconds "minted/most-recently-written" time
StorageDoubleMap<_, Blake2_128Concat, AccountOrPerson<AccountId>,
                    Blake2_128Concat, Nft, u32>
```

For the current user (the `AccountOrPerson` first key), iterate the second
key and value:

- **`Nft` (the second key)** → `OwnedNft.hash`. This is the 32-byte NFT hash;
  serialize it as a hex string (`0x`-prefixed is fine, case-insensitive).
- **`u32` (the value)** → `OwnedNft.mintedAt`. **Unix seconds.** Per the
  pallet docs this is the *most recent* write time for that key (backfills
  overwrite), and within a single game these cluster together — fine for our
  "newest first" sort and date labels.

### 2.2 `NftCandidates` — staged / held NFTs (optional)

```rust
// (prospective owner, NFT hash) -> ()  — held NotPerson reports, undecided
StorageDoubleMap<_, Blake2_128Concat, AccountOrPerson<AccountId>,
                    Blake2_128Concat, Nft, ()>
```

If you want to show earned-but-not-yet-finalised collectibles, deliver each
candidate as `{ hash, pending: true }` (no `mintedAt` — there's no timestamp).
They render dimmed with a "PENDING" badge and no date. **Omit this entirely
if you'd rather only show confirmed mints** — the catalogue is complete
without candidates.

> When a candidate is later promoted into `Nfts`, just re-deliver it as a
> normal confirmed item (no `pending`, with its `mintedAt`).

### 2.3 People Chain username (optional)

`displayName` is **not** in the NFT maps — it's the user's People Chain
identity username (`Identity::usernameOwnerOf` / the primary username),
the same value game-results displays. Query it if you want the gallery
titled with the handle (e.g. `byteboro.42`). If omitted, the title falls
back to `your collection`. No other field depends on it.

### 2.4 What native does **not** need to provide

Everything below is derived **client-side from the hash alone** — do not look
for or send chain fields for these:

- **artwork, display name ("Black Opal"), rarity (common/rare)** — a pure
  function of the hash bytes via the bundled catalogue index (see §7).
- **owner address, edition number, attributes, collection metadata** — not
  shown anywhere, so not required.

---

## 3. Bridge surface (web side)

All globals are registered at module load, so native can call them **before
React mounts** without the call being dropped (buffer-or-deliver). They are
idempotent and may be combined.

### 3.1 `window.setCollection(input: CollectionInput): void`

Replaces the **entire** owned set and (if present) the display name. Use this
for the normal "here's everything" delivery and for refreshes. Calling it
again fully replaces the previous set.

### 3.2 `window.__COLLECTION__: CollectionInput`

Same object, assigned to the global **before** the bundle's JS executes. Read
once on boot. Equivalent to calling `setCollection` immediately.

### 3.3 `window.pushNft(item: OwnedNft): void`

Upserts a **single** item, keyed by normalized hash (lowercase, no `0x`). Use
when the owned set is large or arrives incrementally as you page through
storage. An item with a hash already present is overwritten. Does not clear
anything else.

### 3.4 Events transport

The webview posts events to native, transport auto-detected in priority
order. **Register your handler under the name `collectibles`:**

1. **iOS (WKWebView):** `window.webkit.messageHandlers.collectibles.postMessage(obj)`
   — receives a JS object.
2. **Android:** `window.collectibles.postMessage(jsonString)` — register a
   `@JavascriptInterface` object named `collectibles` with a
   `postMessage(String)` method; receives a JSON string.
3. Fallback: `console.debug` (plain-browser dev — nothing to wire).

Detecting either handler also flips the webview into **embedded mode** (§8).

---

## 4. `CollectionInput` — Full Schema

```ts
interface CollectionInput {
  owned: OwnedNft[]      // every collectible the user owns
  displayName?: string   // optional handle, e.g. "byteboro.42" (≤24 chars)
}

interface OwnedNft {
  hash: string           // 32-byte NFT hash, 64 hex chars, optional 0x prefix
  mintedAt?: number      // Unix SECONDS (the u32 from Nfts). Omit if unknown.
  pending?: boolean       // true = staged NftCandidates entry. Default false.
}
```

### Field rules

- **`hash`** — case-insensitive hex; a leading `0x` is stripped. Malformed
  hashes (wrong length / non-hex) fall back to the first catalogue image and
  log a warning — they never crash the gallery. De-dupe is by exact hash
  (last write wins).
- **`mintedAt`** — **Unix seconds.** Drives the "Newest" sort and the
  absolute date ("27 May 2026") + relative ("3d ago") labels. Items without
  it sort last and show no date.
- **`pending`** — `true` only for `NftCandidates` entries. Renders dimmed +
  "PENDING", no date.
- **`displayName`** — sanitized by the webview (trimmed, ≤24 chars, HTML-ish
  characters stripped). Absent → title shows `your collection`.

### Minimal valid payload

```js
window.setCollection({
  owned: [
    { hash: "0x9f3c…a1", mintedAt: 1748300000 },
    { hash: "0x14b0…c8", mintedAt: 1748100000 }
  ]
})
```

---

## 5. `FlowEvent` — Events the Webview Emits

All events are JSON-round-trip-safe (no `Date`/`BigInt`/`undefined`).

| `type` | Payload | When |
|---|---|---|
| `flow.ready` | — | Once, after first paint. The bridge is listening. |
| `flow.gallery_shown` | `{ count: number }` | Gallery mounted + entrance ran. `count` = owned items. |
| `flow.item_opened` | `{ hash: string }` | Detail view shown — on open **and on each swipe**. `hash` is `0x`-prefixed. |
| `flow.item_closed` | `{ hash: string }` | Detail view closed back to the gallery. |
| `flow.error` | `{ phase, detail? }` | See phases below. |
| `flow.close` | — | **Reserved.** Not emitted by any built-in UI today — native owns dismissal. Available if a web-side dismiss is added later. |

### `flow.error` phases

- **`boot_timeout`** — no collection delivered within 8 s. The webview falls
  back to the empty state. (Usually means native never called
  `setCollection`/`pushNft`.)
- **`assets`** — one or more catalogue images failed to load; `detail` is
  `image_failures=<n>`. Emitted as a debounced rollup, only when the failure
  count grows. **Most likely cause: expired Bulletin Chain testnet CIDs**
  (see §7) — treat as a signal to re-upload the catalogue. The running count
  is also readable directly at `window.__ASSET_FAILURES__`.

---

## 6. Lifecycle & Timing

```
load bundle
   │
   ├─ window.__COLLECTION__ present?  ──► render gallery immediately
   │
   ├─ else cached collection from a previous session? ──► render it immediately
   │       (a later setCollection / pushNft replaces it live)
   │
   ├─ else show "Opening your collection…" boot state
   │       │
   │       ├─ setCollection / pushNft arrives ──► render gallery
   │       └─ 8 s elapse, nothing arrives    ──► empty state + flow.error(boot_timeout)
   │
   └─ flow.ready (after first paint, once)
```

- Deliver as early as you can. Pre-setting `window.__COLLECTION__` gives the
  smoothest boot (no spinner). A late `setCollection` is fine too.
- The webview persists the most recent delivered collection to WebView
  localStorage and boots from it when native hasn't spoken yet — so an
  offline or slow session shows the last-known set rather than "no
  collectibles". Native should still deliver whenever it can; the cache is a
  fallback, not a data source. `flow.error(boot_timeout)`'s `detail` reports
  `showing_cached` or `no_cache` so hosts can tell the two apart.
- `setCollection` / `pushNft` can be called repeatedly; the gallery updates
  live (e.g. a candidate promoted to confirmed, or streamed pages arriving).
- There is no "done" / completion step — the catalogue is a browseable view,
  not a linear flow. Native dismisses it whenever the user navigates away.

---

## 7. Hash → image resolution (FYI — native implements nothing)

For context only. The bundled `src/collectibles/cid_map.json` indexes the
catalogue images (uploaded to the Bulletin Chain). For each hash the
webview computes, deterministically:

- bytes **0–1** (uint16) → rarity roll; `< 7865` (~12%) selects the **rare**
  pool, else the normal pool. (7865 absorbs the retired Web3 Summit sticker
  band — see EVENT_EXCLUSIVES.md; do not change it.)
- bytes **2–3** (uint16) → image index, `mod poolSize`, into the
  lexicographically-sorted pool.

So **rarity and artwork are a pure function of the hash** — there is no
on-chain rarity field to send, and the badge always matches the art. Images
are fetched from the Bulletin Chain IPFS gateway by CID.

> ⚠️ **Operational note:** Bulletin Chain *testnet* CIDs expire (~2 weeks).
> When art stops loading you'll see `flow.error { phase: "assets" }`; the fix
> is to re-upload via `~/git/CollectableHashResolver` and ship a regenerated
> `cid_map.json` in the bundle. This is a build-time concern, not a runtime
> chain read.

---

## 8. Embedding & safe areas

The webview renders **full-bleed by default** — it fills the entire viewport,
which is the real experience on any phone or tablet (and inside the native
WebView). There is no chrome to opt into; a device just sees the actual view.

The centered "phone-frame" mockup (bezel + fake status bar) is a
**desktop-preview convenience only** — it appears solely on mouse-driven
desktop screens with room for it (`(pointer: fine) and min 720×720`). Touch
devices never see it.

When a `collectibles` bridge handler is detected (iOS or Android), the webview
also sets `body.is-embedded`, which guarantees full-bleed even on a
desktop-sized host. Force the full-bleed view on desktop for testing with
`?embed=1`.

The page sets `viewport-fit=cover` and the layout honors
`env(safe-area-inset-*)` (top inset clears the status bar / notch). Lay the
WebView out edge-to-edge under the notch / home indicator so the gallery
header and scroll padding compute the insets correctly.

---

## 9. Implementation Checklist (Native)

### Required (load-bearing) — chain-bridge path (§11)

- [ ] Provide the `collectiblesChain` JSON-RPC proxy (Asset Hub + People
      Chain, multiplexed by the `chain` field) and call
      `window.onChainRpcMessage(chain, ...)` with every response.
- [ ] Supply the purse address list via `window.__ACCOUNTS__` /
      `window.setAccounts([...])`.
- [ ] Supply the player identity via `window.__PLAYER__` /
      `window.setPlayerIdentity({...})` (credits leg; optional).
- [ ] Register a `collectibles` message handler (iOS `messageHandlers` /
      Android `@JavascriptInterface`) to receive `flow.*` events.
- [ ] Lay out the WebView full-bleed with safe-area insets respected.

### Required — legacy push path (hosts without the chain bridge)

- [ ] Read `Scarcity.NftsByOwner` per purse + the `"hash"` metadata →
      deliver `owned: [{ hash, mintedAt }]` via `window.setCollection(...)`
      (or `__COLLECTION__`, or streamed `pushNft`). `mintedAt` in
      **seconds**.

### Recommended (graceful degradation)

- [ ] Query the People Chain username → `displayName` (else falls back to
      `your collection`).
- [ ] Read `NftCandidates(currentUser, *)` → deliver as `{ hash, pending: true }`.
- [ ] Handle `flow.error { phase: "assets" }` (and/or read
      `window.__ASSET_FAILURES__`) to detect expired catalogue CIDs.
- [ ] Provide a native back / dismiss affordance (the webview doesn't render
      one).

### Not required

- Sending rarity, artwork URLs, names, edition numbers, owner address, or any
  other per-NFT metadata — all derived from the hash.

---

## 10. Out of Scope (Future)

- A "full collection with locked slots" / completion-% mode (current design
  is owned-only).
- Grouping by game/batch using the clustered `mintedAt` timestamps.
- Sharing a collectible out (image export / deep link).
- A web-side dismiss button emitting `flow.close`.

---

## 11. Chain Provider Bridge (PROPOSED — needs native sign-off)

The webview embeds `polkadot-api` and performs the chain reads itself,
against **two chains**: Asset Hub (`Scarcity.NftsByOwner` + metadata →
minted items) and the People Chain (the `Game` pallet's credit trees +
`PalletGameApi` runtime APIs → earned credits, rendered as wrapped/pending
items until minted). It never opens
a socket inside a host; instead the host proxies raw JSON-RPC to its own
chain connections. One bridge multiplexes both chains — every message
names its chain:

```js
// web -> native: {"chain": "assetHub" | "people", "msg": <JSON-RPC obj>}
// serialized as one JSON string per call.
window.webkit.messageHandlers.collectiblesChain.postMessage(jsonString) // iOS
window.collectiblesChain.postMessage(jsonString)                       // Android

// native -> web: every JSON-RPC response/notification for that chain,
// as a JSON string (the inner msg only, not the wrapper).
window.onChainRpcMessage(chain, jsonString)
```

- The webview registers `onChainRpcMessage` at module load (buffer-or-
  deliver per chain, bounded at 50 pre-connection messages) — safe to
  call early.
- The nodes behind the connections must support the `chainHead_v1_*` /
  modern JSON-RPC spec (both gamingnet testnet chains do).
- **Detection:** if neither `collectiblesChain` transport exists, the
  chain layer stays completely inert inside a host — the legacy push path
  (§0) is then the only data source. Outside a host (desktop dev), the
  webview falls back to direct WebSockets to the gamingnet testnet.
- The People Chain connection is optional: without it the shelf is
  minted-items-only, never an error.

**Which accounts to read** — the host supplies the purse address list:

```js
// Before the bundle's JS runs:
window.__ACCOUNTS__ = ["5Dnw…", "5GNE…"]
// Or at any later point (replaces the list; buffer-or-deliver):
window.setAccounts(["5Dnw…", "5GNE…"])
```

Invalid SS58 entries are dropped with a console warning. An **empty list
means "stay silent"** — the webview will not deliver an empty collection
just because it wasn't told any addresses (that keeps the push path
authoritative until accounts arrive).

When NO explicit source speaks and the app is NOT embedded, the built-in
**account deriver** supplies the list instead: purse `i` at derivation
path `//product//scarcity//nft//<i>` (interim convention, not
platform-ratified), walked over a 64-index window, dev keys derived
in-page from the public Substrate dev mnemonic. Inside a host the deriver
stays off until the host exposes a public-key-at-index capability —
in-page derivation from a real user root is never acceptable. Errors during chain sync surface as
`flow.error { phase: "chain", detail }` and retry with backoff (5 s → 60 s).

**Who the player is** — the host supplies the credit-map identity
(the pallet's `AccountOrPerson`):

```js
// Before the bundle's JS runs:
window.__PLAYER__ = { account: "5Dnw…" }        // account-based player
window.__PLAYER__ = { alias: "0x" + 64 hex }     // person/alias-based player
// Or at any later point (buffer-or-deliver); pass null to clear:
window.setPlayerIdentity({ account: "5Dnw…" })
```

Without an identity the credits leg is skipped (minted-items-only shelf).
Earned credits are delivered to the gallery as `pending: true` items
keyed by the credit hash; when `pallet-scarcity-claims` lands on Asset
Hub, the webview will additionally split Earned/Claimable by checking
roots (no host change needed).

> The production rules for *which* purse addresses belong to the player
> (derivation convention, cross-purse visibility) and *which identity*
> queries the credit map (account vs alias, voucher keys) are open
> platform questions; these seams are deliberately minimal.

---

## 12. Test Scenarios (no native required)

Append query params in any browser:

| Param | Effect |
|---|---|
| `?dev=1` | Dev panel: load mock collections, reload. |
| `?mock=<name>` | Auto-load a scenario on boot: `small`, `typical`, `collector`, `rare`, `pending`, `empty`. Disables chain sync. |
| `?address=<ss58>[,<ss58>…]` | Read these purse addresses from the gamingnet testnet (persisted for reloads). |
| `?player=<ss58>` / `?alias=<0xhex32>` | Read this identity's credits from the People Chain (persisted for reloads). |
| `?open=<n>` | Auto-open the nth tile's detail view. |
| `?embed=1` | Force embedded full-screen layout. |

Examples:
- `…/index.html?mock=typical` — populated gallery in the desktop phone frame.
- `…/index.html?mock=rare&open=0&embed=1` — a rare item's detail, on-device layout.

The mock data exercises confirmed + pending items, common + rare, realistic
handles (`byteboro.42`), and timestamps clustered into "games".

---

## 13. Versioning Note

This contract is intentionally small: a purse-address list + a JSON-RPC
proxy in (or, on the push path, the pre-read owned set), six event types
out. If a future build needs more (e.g.
locked-slot mode), it will add **optional** fields to `CollectionInput` and
new `flow.*` variants — never repurpose existing ones. Native can read the
shipped TypeScript types as the source of truth: `src/bridge/types.ts`.
