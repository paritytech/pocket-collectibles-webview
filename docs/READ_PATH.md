# How the read path works

How the webview assembles the shelf from chain data, as implemented in
`src/chain/`. Two views: where the data source comes from (once, at
startup), and what one poll cycle reads (repeating).

## 1. Startup: choosing the data source

```mermaid
flowchart TD
    boot["main.tsx<br/>initIdentity() → startChainSync()"] --> mock{"?mock= in URL?"}
    mock -- yes --> inert1["inert — mocks drive the store<br/>via deliverCollection"]
    mock -- no --> cont{"product-sdk container?<br/>(isInsideContainerSync)"}
    cont -- yes --> sdk["client.ts: createChainClient<br/>(chain-client BYOD over our descriptors);<br/>every connection served by the HOST<br/>over the truapi port, by genesis hash"]
    cont -- no --> emb{"embedded in a<br/>legacy native WebView?"}
    emb -- yes --> inert2["inert — no connection allowed<br/>inside a host; cached shelf /<br/>boot timeout only"]
    emb -- no --> ws["client.ts: dev fallback<br/>direct WebSockets to gamingnet<br/>asset-hub + people"]
    sdk --> loop["poll loop (§2)"]
    ws --> loop

    purses["purses.ts — the purse subtree<br/>container: host product accounts<br/>getProductAccount(dotNs, i) |<br/>dev: derive.ts //nft//i from DEV_PHRASE"] -.-> loop
    identity["identity.ts — player identity<br/>container: product account 0 |<br/>dev: ?player= / ?alias= / persisted"] -.-> loop
```

The two dotted inputs are the open-platform-question seams: *which purse
addresses* belong to the player (product accounts by index vs the dev
`//nft//i` derivation — both sides of the mint/claim pipeline must agree,
dependency #5) and *which identity* queries the credit map (product
account 0 vs a person alias, dependencies #2/#3). Identity is a
subscription — a change restarts the poll.

## 2. One poll cycle (every 30 s, backoff on error)

```mermaid
sequenceDiagram
    participant ST as chain/start.ts
    participant SC as chain/pallets/scarcity.ts
    participant CR as chain/pallets/credits.ts
    participant AH as Asset Hub
    participant PC as People Chain
    participant CO as collection/store.ts
    participant UI as React (App.tsx)

    Note over ST: poll() — both chains in parallel

    par owned items (Asset Hub)
        ST->>SC: scanOwned(purseSource) → fetchOwnedAt(addresses)
        SC->>AH: Scarcity.NftsByOwner.getValues([addr…])
        AH-->>SC: Nft { instance, collection, item, minted_at } per hit
        SC->>AH: api ScarcityApi.metadata_batch([Instance(id)…])<br/>(ONE call, all three metadata layers per instance)
        AH-->>SC: hash/name/image pairs, resolved<br/>Instance → Item → Collection, most specific wins
        SC-->>ST: OwnedNft[] = { hash, mintedAt }
    and earned credits (People Chain, optional)
        ST->>CR: fetchCredits(identity)
        CR->>PC: NftCredits.NftClaimCreditBlocks(AccountOrPerson)<br/>+ api: NftCreditsApi.nft_claim_credit_roots(claimant)
        PC-->>CR: my award blocks | [(block, { root, timestamp, … })]
        CR->>PC: rooted blocks: api nft_claim_credit_proofs(block, claimant)
        PC-->>CR: proofs carrying each credit hash and leaf<br/>(cached for the Phase-2 claim flow)
        CR->>PC: rootless newest block: NftCredits.NftClaimCreditAwards(block)
        PC-->>CR: the block's award buffer, filtered to this claimant
        CR-->>ST: Credit[] = { hash, awardedAt?, awardBlock?, root?, leaf? }
    end

    Note over ST: fetchClaimStates() (chain/pallets/claims.ts, Asset Hub):<br/>NftClaims.CreditTrees(block) — root arrived?<br/>NftClaims.ClaimedCredits(block) — leaf claimed?

    Note over ST: mergeShelf():<br/>minted hash wins over same-hash credit;<br/>root not on Asset Hub → pending (wrapped/Earned);<br/>root there, leaf unclaimed → pending + claimable;<br/>leaf claimed → credit dropped, its item<br/>shows up via the scan on its own.

    ST->>CO: deliverCollection({ owned })
    Note over CO: the single store: coerce → dedup by hash →<br/>generation bump only if the item SET changed
    CO->>CO: write-back localStorage cache
    CO-->>UI: snapshot → render shelf
    Note over UI: cache-first: shelf rendered from cache at boot<br/>(only when the cache was saved under the same<br/>player identity), this delivery corrects it
```

## What each module owns

| Module | Owns |
|---|---|
| `chain/client.ts` | where bytes come from: product-sdk container (`createChainClient`, host-served by genesis hash; host without Asset Hub → retried failure + error state, sockets only under a `?player=` QA override) vs dev WS vs inert; teardown/rebuild for wedged connections |
| `chain/devClient.ts` | the dev connection path: direct testnet WebSockets, one lazy client per chain (`TESTNET_WS`) |
| `chain/product.ts` | the product's DotNS identifier (value pending team ratification) |
| `chain/purses.ts` | the purse-address seam: `PurseSource` — container impl asks the host for product accounts by index (memoized; capability PROBED — absent in today's hosts → dev impl stands in) |
| `chain/devPurses.ts` | the dev purse source: in-page DEV_PHRASE derivation over `derive.ts` |
| `chain/pallets/scarcity.ts` | Asset Hub reads: `NftsByOwner`, plus ONE `ScarcityApi.metadata_batch` runtime call serving all three metadata layers (`"hash"`/`"name"`/`"image"`) per poll |
| `chain/pallets/credits.ts` | People Chain reads: award blocks, roots, proofs, rootless awards buffer |
| `chain/pallets/claims.ts` | Asset Hub nft-claims reads: `CreditTrees` root arrival, `ClaimedCredits` claimed leaves → per-credit Earned/Claimable/claimed state |
| `chain/derive.ts` | the DEV-ONLY account deriver: `//nft//i` (the retreat web-demo's convention, adopted 2026-08-11 so both in-house minting surfaces share purses) from `DEV_PHRASE` in-page — inside a container, host product accounts replace it (purses.ts) |
| `chain/identity.ts` | the player-identity seam: type, validation gate, subscription; container → product account 0 via `initIdentity()` |
| `chain/devIdentity.ts` | the dev identity inputs: `?player=`/`?alias=` QA override, dev-name expansion, dev-session persistence |
| `chain/start.ts` | the loop: inputs → parallel fetch → mergeShelf → deliverCollection; errors → `flow.error phase=chain` + backoff (a host refusing Asset Hub stops the session's sync) |
| `collection/store.ts` | the single store the chain sync (and dev mocks) feed |

## Not implemented yet (marked seams)

- **The purse convention is half-answered** (dependency #5) — inside a
  container the host's `getProductAccount(dotNs, i)` IS the
  public-key-at-index capability (purses.ts, since 2026-08-13); what
  remains open is ratifying the DotNS identifier (`chain/product.ts`) and
  the mint/claim pipeline agreeing to deposit into those product accounts
  by index. Dev keeps the retreat web-demo's `//nft//i` from DEV_PHRASE
  (adopted 2026-08-11, replacing our `//product//scarcity//nft//i`) —
  note the two schemes yield DIFFERENT addresses, so a shelf minted via
  dev derivation is invisible to container mode and vice versa.
- **Credit-hash == item-hash assumption — VERIFIED FALSE for pallet
  claims (2026-08-11)**: `pallet-nft-claims::claim` mints with empty
  metadata (`mint_without_deposit(.., Vec::new())`), so a claim-minted
  item never carries the credit hash; only tooling-minted items do.
  Model adopted 2026-08-12 (matches the design direction): claimed
  credits are DROPPED from the shelf — the shared purse convention means
  their item arrives via the scan, and ownership is the whole story the
  shelf tells. Hashless items (the pallet claim is the only metadata-less
  minter) are keyed `instance-<id>` so they still render. Which credit
  an item came from stays unrecorded on-chain — only the `CreditClaimed`
  event (block/leaf/collection/item/owner/instance) has it,
  archive-walk-only; if provenance ever becomes a product requirement,
  the fix is a runtime change (write the credit into the instance's
  `"hash"` metadata at claim time) or an indexer. Replaying the pallet's
  item selection to guess was tried and REJECTED (fails silently when
  the collection grows).
- **Claiming/minting** (Phase 2) — `nft_claim_credit_proofs` hands out
  ready-made inclusion proofs (the claim builder re-fetches at claim
  time; a cross-poll proof cache was removed 2026-08-12) and Claimable
  items are flagged (`OwnedNft.claimable`); `NftClaims.claim(block,
  credit, leaf_index, proof, collection, mint_to)` is live on the testnet
  Asset Hub, so what remains is the claim builder, the signing seam — and
  the identity carry-through above, without which a fresh claim's item
  won't show as the credit it came from.
