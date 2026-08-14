// The mint flow's UI-facing facade. The overlay (components/MintOverlay.tsx)
// talks to this, never to the client/pallet modules directly: one place that
// acquires the session's connection and, for signing, its identity + signer.
//
//   loadMintCollections  — the collections a credit may be spent into
//   loadMintPreviews     — what a credit would mint into each (blurred preview)
//   claimCredit          — spend the credit (re-export of start.ts, which also
//                          forces an immediate re-poll on success)
//   subscribeCanMint     — whether this session can sign a claim at all, so
//                          the UI hides the mint action instead of dead-ending

import { getChainApis } from './client'
import { fetchMintCollections, type MintCollection } from './pallets/minters'
import { previewMints, type MintPreview } from './pallets/preview'
import { getSigner } from './signing'
import { getIdentitySource } from './identity'

export type { MintCollection } from './pallets/minters'
export type { MintPreview } from './pallets/preview'
export type { ClaimParams, ClaimStatus, ClaimResult } from './claim'
export { claimCredit } from './start'

/** The collections registered to accept claims, with names resolved. */
export async function loadMintCollections(): Promise<MintCollection[]> {
  const apis = await getChainApis()
  if (!apis) throw new Error('no chain connection this session')
  return fetchMintCollections(apis.assetHub)
}

/** What claiming `credit` would mint into each of `collections`. */
export async function loadMintPreviews(credit: string, collections: number[]): Promise<MintPreview[]> {
  const apis = await getChainApis()
  if (!apis) throw new Error('no chain connection this session')
  return previewMints(apis.assetHub, credit, collections)
}

/** Fires immediately with whether this session can sign a claim, then again
 *  whenever the identity changes. A session that can't sign (a real host
 *  without product-account signing, or an alias identity) reports false and
 *  the UI keeps the mint action hidden. Returns an unsubscribe function. */
export function subscribeCanMint(cb: (canMint: boolean) => void): () => void {
  return getIdentitySource().subscribe((identity) => {
    getSigner(identity).then((signer) => cb(signer !== null)).catch(() => cb(false))
  })
}
