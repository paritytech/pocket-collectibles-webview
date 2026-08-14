/** 
 * On-chain read path for pallet-nft-claims (Asset Hub)
 * 
 *  storage  NftClaims.CreditTrees: AwardBlock -> { game_index, root, leaf_count, timestamp }
 *    root present: the block's credits are verifiable here, so they are
 *    Claimable (or already claimed). Root absent: still Earned.
 *  storage  NftClaims.ClaimedCredits: (AwardBlock, leaf) -> ()
 *    a recorded leaf is a minted credit — possibly by another device or
 *    the auto-claim, so absence from our purse scan proves nothing.
 *
 * Typed against generated descriptors (`next-asset-hub-paseo` ≥ 2000036).
 * ClaimedCredits' value is the unit type, so claimed leaves are
 * enumerated per block with getEntries instead of point-read.
 */
import type { Credit } from './credits'
import type { AssetHubApi } from '../client'

const AT = { at: 'best' } as const

/** 
 * Where an unminted credit stands on Asset Hub (design doc §3.1):
 * 
 *  `earned` — its tree's root has not arrived, nothing to verify against;
 *  `claimable` — root present, leaf unclaimed, a claim would mint;
 *  `claimed` — leaf recorded, the item exists (here or on another device).
 * 
 */
export type ClaimState = 'earned' | 'claimable' | 'claimed'

/** 
 * Resolve each credit's ClaimState, batched: one CreditTrees read per
 *  distinct award block, one ClaimedCredits enumeration per block whose
 *  root arrived. Credits without a proof yet (rootless, seconds old) are
 *  `earned` without any read. 
 */
export async function fetchClaimStates(
  api: AssetHubApi,
  credits: Credit[]
): Promise<Map<string, ClaimState>> {
  const states = new Map<string, ClaimState>()
  const blocks = [
    ...new Set(
      credits
        .filter((c) => c.awardBlock !== undefined && c.leaf !== undefined)
        .map((c) => c.awardBlock as number)
    )
  ]

  const trees =
    blocks.length > 0
      ? await api.query.NftClaims.CreditTrees.getValues(
          blocks.map((b) => [b] as [number]),
          AT
        )
      : []
  const rooted = blocks.filter((_, i) => trees[i] !== undefined && trees[i] !== null)

  const claimedByBlock = new Map<number, Set<string>>()
  await Promise.all(
    rooted.map(async (block) => {
      const entries = await api.query.NftClaims.ClaimedCredits.getEntries(block, AT)
      const leaves = new Set<string>()
      for (const entry of entries ?? []) {
        leaves.add(entry.keyArgs[1].toLowerCase())
      }
      claimedByBlock.set(block, leaves)
    })
  )

  for (const credit of credits) {
    const claimed =
      credit.awardBlock !== undefined && credit.leaf !== undefined
        ? claimedByBlock.get(credit.awardBlock)
        : undefined
    if (!claimed) {
      states.set(credit.hash, 'earned')
    } else if (claimed.has(credit.leaf!)) {
      states.set(credit.hash, 'claimed')
    } else {
      states.set(credit.hash, 'claimable')
    }
  }
  return states
}

