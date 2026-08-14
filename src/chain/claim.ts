// The mint claim — the app's FIRST extrinsic (design doc Phase 2).
//
// Spending a claimable credit means submitting `NftClaims.claim`, signed by
// the claimant (the account the credit was awarded to). This module builds
// that call and watches it to finality; who signs is the signing seam
// (signing.ts), which purse it mints INTO is the purse seam (purses.ts). The
// pieces:
//   - the inclusion proof is re-fetched live from the People Chain
//     (pallets/credits.ts) — proofs are not cached across polls;
//   - `mint_to` must be an EMPTY purse key (a purse holds one NFT), so we
//     mint into the first free index of the player's purse subtree — the
//     same low-index-first layout the shelf scan walks;
//   - the claimant kind is Account today (our identities are accounts); a
//     Person alias claim (dependency #2/#3) is not built, and the caller is
//     expected to have resolved a signer for an account identity only.

import { Enum } from 'polkadot-api'
import type { PolkadotSigner } from 'polkadot-api/signer'
import type { ChainApis } from './client'
import type { PlayerIdentity } from './identity'
import type { PurseSource } from './purses'
import { fetchClaimProof } from './pallets/credits'
import { fetchOwnedAt } from './pallets/scarcity'

/** What the caller needs to spend one credit: which credit, the People-chain
 *  block it was awarded in (names the tree the proof verifies against), and
 *  the chosen collection. */
export interface ClaimParams {
  credit: string
  awardBlock: number
  collection: number
}

/** Coarse progress of a submission, for the overlay's status line. */
export type ClaimStatus = 'signing' | 'inBlock' | 'finalized'

export interface ClaimResult {
  ok: boolean
  /** A human-readable reason when `ok` is false. */
  error?: string
}

// Purse scan window for finding an empty mint target. Claims mint low-index
// first, so a free key is almost always in the first batch.
const FREE_SCAN_BATCH = 10
const FREE_SCAN_MAX = 1_000

/** The first empty purse address of `source`'s subtree — the mint target. */
async function firstFreePurse(apis: ChainApis, source: PurseSource): Promise<string> {
  for (let start = 0; start < FREE_SCAN_MAX; start += FREE_SCAN_BATCH) {
    const indexes = Array.from({ length: FREE_SCAN_BATCH }, (_, k) => start + k)
    const addresses = await Promise.all(indexes.map((i) => source.addressAt(i)))
    const reads = await fetchOwnedAt(apis.assetHub, addresses)
    const free = reads.findIndex((r) => !r.occupied)
    if (free >= 0) return addresses[free]
  }
  throw new Error('no empty purse in the first 1000 indexes')
}

/** Read the nested dispatch error into a readable path, e.g.
 *  "Module · NftClaims · AlreadyClaimed". */
function dispatchErrorText(err: { type: string; value: unknown } | undefined): string {
  const parts: string[] = []
  let cur: unknown = err
  while (cur && typeof cur === 'object' && 'type' in cur && typeof (cur as { type: unknown }).type === 'string') {
    const node = cur as { type: string; value?: unknown }
    parts.push(node.type)
    cur = node.value
  }
  return parts.join(' · ') || 'the claim failed on-chain'
}

/** Build, sign, and watch a claim to finality. Resolves once — never
 *  rejects — with `ok` and, on failure, a reason. `onStatus` reports coarse
 *  progress for the UI. */
export async function submitClaim(
  apis: ChainApis,
  identity: PlayerIdentity,
  source: PurseSource,
  params: ClaimParams,
  signer: PolkadotSigner,
  onStatus: (status: ClaimStatus) => void
): Promise<ClaimResult> {
  if (identity.kind !== 'account') {
    return { ok: false, error: 'claiming as a person alias is not supported yet' }
  }
  if (!apis.people) {
    return { ok: false, error: "can't reach the credits chain to prove this claim" }
  }
  const proof = await fetchClaimProof(apis.people, identity, params.awardBlock, params.credit)
  if (!proof) {
    return { ok: false, error: 'no claim proof for this credit — it may already be claimed' }
  }
  const mintTo = await firstFreePurse(apis, source)

  const tx = apis.assetHub.tx.NftClaims.claim({
    claimant: Enum('Account'),
    block: params.awardBlock,
    credit: proof.credit,
    leaf_index: proof.leafIndex,
    proof: proof.proof,
    collection: params.collection,
    mint_to: mintTo
  })

  return new Promise<ClaimResult>((resolve) => {
    onStatus('signing')
    let settled = false
    const done = (result: ClaimResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const sub = tx.signSubmitAndWatch(signer).subscribe({
      next: (event) => {
        if (event.type === 'txBestBlocksState' && event.found) {
          onStatus('inBlock')
        } else if (event.type === 'finalized') {
          onStatus('finalized')
          done(event.ok ? { ok: true } : { ok: false, error: dispatchErrorText(event.dispatchError) })
          sub.unsubscribe()
        }
      },
      error: (err: unknown) => {
        done({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  })
}
