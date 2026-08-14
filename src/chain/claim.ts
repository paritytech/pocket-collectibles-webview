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
import { firstFreePurse } from './pallets/scarcity'
import { watchSubmission, type SubmitStatus, type SubmitResult } from './submit'

/** What the caller needs to spend one credit: which credit, the People-chain
 *  block it was awarded in (names the tree the proof verifies against), and
 *  the chosen collection. */
export interface ClaimParams {
  credit: string
  awardBlock: number
  collection: number
}

/** Coarse progress of a submission, for the overlay's status line. */
export type ClaimStatus = SubmitStatus

export type ClaimResult = SubmitResult

/** Build, sign, and watch a claim to inclusion. Resolves once — never
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
  const mintTo = await firstFreePurse(apis.assetHub, source)

  const tx = apis.assetHub.tx.NftClaims.claim({
    claimant: Enum('Account'),
    block: params.awardBlock,
    credit: proof.credit,
    leaf_index: proof.leafIndex,
    proof: proof.proof,
    collection: params.collection,
    mint_to: mintTo.address
  })

  return watchSubmission(tx, signer, onStatus)
}
