/** 
 * On-chain read path for pallet-nft-credits (People Chain).
 * 
 *   Each block's awarded credits form one merkle tree; the root is
 *   recorded in the NEXT block and streamed to Asset Hub, which verifies
 *   claims against it (nft-claims reads: chain/pallets/claims.ts).
 * 
 *   storage  NftCredits.NftClaimCreditBlocks: AccountOrPerson -> Vec<BlockNumber>
 *     the claimant's award blocks — the index everything starts from.
 *   storage  NftCredits.NftClaimCreditAwards: BlockNumber -> Vec<{ claimant, credit }>
 *     each retained block's awards, in award order. The newest block's
 *     entry is the still-rootless buffer — read directly so credits show
 *     within seconds of being earned.
 *   runtime API  NftCreditsApi.nft_claim_credit_roots(claimant)
 *     -> Vec<(award_block, { game_index, root, leaf_count, timestamp })>
 *   runtime API  NftCreditsApi.nft_claim_credit_proofs(award_block, claimant)
 *     -> Result<Vec<{ root, credit, leaf, leaf_index, leaf_count, proof }>, err>
 *     ready-made inclusion proofs — exactly what Asset Hub verifies a
 *     mint against (Phase 2: claiming). Cached here per credit.
 *
 * The player's identity is the pallet's `AccountOrPerson` enum: a plain
 * account, or an alias (32-byte person id). Which one this player uses is
 * an open platform question (DEPENDENCIES.md #2/#3); identity.ts isolates it.
 *
 * 32-byte values (credits, leaves, roots) are `[u8; N]`, which the typed
 * api serves as 0x-hex strings; normalize to lowercase before comparing.
*/

import { Enum } from 'polkadot-api'
import { pubkeyHexOf } from '../ss58'
import type { PlayerIdentity } from '../identity'
import type { PeopleApi } from '../client'

const AT = { at: 'best' } as const

/** The `AccountOrPerson` claimant, as the descriptors type it. */
type Claimant = Parameters<PeopleApi['apis']['NftCreditsApi']['nft_claim_credit_roots']>[0]

/** One awarded credit, as the shelf needs it. `awardedAt`/`root`/`leaf`
 *  are present once the credit's block has its root (a block later);
 *  a rootless credit is seconds old. `leaf` is the merkle leaf hash
 *  (lowercase 0x-hex) — the key Asset Hub's `NftClaims.ClaimedCredits`
 *  records a mint under (chain/pallets/claims.ts). */
export interface Credit {
  hash: string
  awardedAt?: number
  awardBlock?: number
  root?: string
  leaf?: string
}

/** The pallet's `AccountOrPerson` key for this player. Aliases travel as
 *  0x-hex (the typed api's `[u8; 32]` representation). */
function ownerKey(identity: PlayerIdentity): Claimant {
  return identity.kind === 'account'
    ? Enum('Account', identity.address)
    : Enum('Person', identity.alias as `0x${string}`)
}

/** Does a decoded `AccountOrPerson` denote this player? Accounts compare
 *  by public key (SS58 prefix-independent); aliases by lowercase hex. */
function isSamePlayer(
  decoded: { type: string; value: unknown },
  identity: PlayerIdentity
): boolean {
  if (identity.kind === 'account' && decoded.type === 'Account' && typeof decoded.value === 'string') {
    const a = pubkeyHexOf(decoded.value)
    const b = pubkeyHexOf(identity.address)
    return a !== null && a === b
  }
  if (identity.kind === 'alias' && decoded.type === 'Person' && typeof decoded.value === 'string') {
    return decoded.value.toLowerCase() === identity.alias.toLowerCase()
  }
  return false
}

/** Credits of one ROOTED award block, via the proofs runtime API.
 *  Falls back to [] on pruned/errored blocks. Note for Phase 2: the same
 *  API hands out ready-made inclusion proofs — the claim builder should
 *  re-fetch at claim time rather than cache across polls (a cache here
 *  was removed 2026-08-12: unbounded, uncalled, and mis-keyed vs the
 *  store's normalized hashes). */
async function creditsOfRootedBlock(
  api: PeopleApi,
  who: Claimant,
  awardBlock: number,
  rootInfo: { root: string; timestamp: number }
): Promise<Credit[]> {
  const result = await api.apis.NftCreditsApi.nft_claim_credit_proofs(awardBlock, who, AT)
  if (!result.success) {
    // AwardsPruned etc: the credit exists but its proof needs the events
    // fallback (nft_claim_credit_proof_from_awards) — a claim-time
    // concern, not a display one. Surface nothing on the shelf... yet.
    console.warn(`[chain] no proofs for award block ${awardBlock}:`, result.value?.type)
    return []
  }
  const root = rootInfo.root.toLowerCase()
  const credits: Credit[] = []
  for (const proof of result.value) {
    const hash = proof.credit.toLowerCase()
    credits.push({
      hash,
      awardedAt: rootInfo.timestamp,
      awardBlock,
      root,
      leaf: proof.leaf.toLowerCase()
    })
  }
  return credits
}

/** Credits of ROOTLESS award blocks (usually just the current block),
 *  read from the awards buffer so fresh earnings show within seconds. */
async function creditsOfRootlessBlock(
  api: PeopleApi,
  identity: PlayerIdentity,
  awardBlock: number
): Promise<Credit[]> {
  const awards = await api.query.NftCredits.NftClaimCreditAwards.getValue(awardBlock, AT)
  const credits: Credit[] = []
  for (const award of awards ?? []) {
    if (!isSamePlayer(award.claimant, identity)) continue
    credits.push({ hash: award.credit.toLowerCase(), awardBlock })
  }
  return credits
}

/** All credits awarded to this player, newest first: rooted blocks via
 *  the runtime APIs (with proofs cached), the rootless newest block via
 *  the awards buffer. */
export async function fetchCredits(api: PeopleApi, identity: PlayerIdentity): Promise<Credit[]> {
  const who = ownerKey(identity)
  const [blocks, roots] = await Promise.all([
    api.query.NftCredits.NftClaimCreditBlocks.getValue(who, AT),
    api.apis.NftCreditsApi.nft_claim_credit_roots(who, AT)
  ])
  const rooted = new Map<number, { root: string; timestamp: number }>()
  for (const [block, info] of roots ?? []) rooted.set(block, info)
  const rootless = (blocks ?? []).filter((b) => !rooted.has(b))

  const batches = await Promise.all([
    ...[...rooted.entries()].map(([block, info]) => creditsOfRootedBlock(api, who, block, info)),
    ...rootless.map((block) => creditsOfRootlessBlock(api, identity, block))
  ])
  return batches
    .flat()
    .sort((a, b) => (b.awardedAt ?? Number.MAX_SAFE_INTEGER) - (a.awardedAt ?? Number.MAX_SAFE_INTEGER))
}
