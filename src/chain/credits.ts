// The credit trees: what the player has EARNED (People Chain).
//
// Model (indiv-pallet-game, verified against the individuality repo and
// the gaming testnet runtime `next-people-paseo` ≥ 1000031 — the earlier
// flat `NftClaimCredits` map is gone):
//
//   Each block's awarded credits form one merkle tree; the root is
//   recorded in the NEXT block. Asset Hub will verify claims against
//   these roots (root sync itself is not deployed yet).
//
//   storage  Game.NftClaimCreditBlocks: AccountOrPerson -> Vec<BlockNumber>
//     the claimant's award blocks — the index everything starts from.
//   storage  Game.NftClaimCreditAwards: BlockNumber -> Vec<{ claimant, credit }>
//     each retained block's awards, in award order. The newest block's
//     entry is the still-rootless buffer — read directly so credits show
//     within seconds of being earned.
//   runtime API  PalletGameApi.nft_claim_credit_roots(claimant)
//     -> Vec<(award_block, { game_index, root, leaf_count, timestamp })>
//   runtime API  PalletGameApi.nft_claim_credit_proofs(award_block, claimant)
//     -> Result<Vec<{ root, credit, leaf, leaf_index, leaf_count, proof }>, err>
//     ready-made inclusion proofs — exactly what Asset Hub will verify a
//     mint against (Phase 2: claiming). Cached here per credit.
//
// The player's identity is the pallet's `AccountOrPerson` enum: a plain
// account, or an alias (32-byte person id). Which one this player uses is
// an open platform question (DEPENDENCIES.md #2/#3); identity.ts isolates it.

import { Binary, Enum, getSs58AddressInfo } from 'polkadot-api'
import type { PlayerIdentity } from './identity'

// Reads resolve at "best" — same phase as the Asset Hub reads.
const AT = { at: 'best' } as const

/** One awarded credit, as the shelf needs it. `awardedAt`/`root` are
 *  present once the credit's block has its root (a block later);
 *  a rootless credit is seconds old. */
export interface Credit {
  hash: string
  awardedAt?: number
  awardBlock?: number
  root?: string
}

/** An inclusion proof as served by `nft_claim_credit_proofs` — kept for
 *  the Phase 2 claim flow. */
export interface CreditProof {
  root: Uint8Array
  credit: Uint8Array
  leaf: Uint8Array
  leaf_index: number
  leaf_count: number
  proof: Uint8Array[]
}

// Narrow contract with the unsafe API (see scarcity.ts for the pattern).
interface StorageValueRead {
  getValue(...args: unknown[]): Promise<unknown>
}
interface RuntimeCall {
  (...args: unknown[]): Promise<unknown>
}
export interface PeopleApi {
  query: {
    Game: {
      NftClaimCreditBlocks: StorageValueRead
      NftClaimCreditAwards: StorageValueRead
    }
  }
  apis: {
    PalletGameApi: {
      nft_claim_credit_roots: RuntimeCall
      nft_claim_credit_proofs: RuntimeCall
    }
  }
}

/** The pallet's `AccountOrPerson` key for this player. */
function ownerKey(identity: PlayerIdentity): unknown {
  return identity.kind === 'account'
    ? Enum('Account', identity.address)
    : Enum('Person', Binary.fromHex(identity.alias))
}

/** Does a decoded `AccountOrPerson` denote this player? Accounts compare
 *  by public key (SS58 prefix-independent); aliases by bytes. */
function isSamePlayer(decoded: unknown, identity: PlayerIdentity): boolean {
  if (!decoded || typeof decoded !== 'object') return false
  const e = decoded as { type?: string; value?: unknown }
  if (identity.kind === 'account' && e.type === 'Account' && typeof e.value === 'string') {
    try {
      const a = getSs58AddressInfo(e.value)
      const b = getSs58AddressInfo(identity.address)
      return a.isValid && b.isValid && Binary.toHex(a.publicKey) === Binary.toHex(b.publicKey)
    } catch {
      return false
    }
  }
  if (identity.kind === 'alias' && e.type === 'Person' && e.value instanceof Uint8Array) {
    return Binary.toHex(e.value) === identity.alias
  }
  return false
}

// Proofs are immutable once a block's root exists; cache per credit hash
// so the claim flow (and repeat polls) never re-fetch them.
const proofCache = new Map<string, CreditProof>()

/** The cached inclusion proof for a credit (0x-hex hash), if any poll has
 *  seen it. Phase 2's claim builder starts here. */
export function getCachedProof(hash: string): CreditProof | undefined {
  return proofCache.get(hash.toLowerCase())
}

/** Credits of one ROOTED award block, via the proofs runtime API (also
 *  primes the proof cache). Falls back to [] on pruned/errored blocks. */
async function creditsOfRootedBlock(
  api: PeopleApi,
  who: unknown,
  awardBlock: number,
  rootInfo: { root: Uint8Array; timestamp: number }
): Promise<Credit[]> {
  const result = (await api.apis.PalletGameApi.nft_claim_credit_proofs(awardBlock, who, AT)) as
    | { success: true; value: CreditProof[] }
    | { success: false; value: { type: string } }
  if (!result.success) {
    // AwardsPruned etc: the credit exists but its proof needs the events
    // fallback (nft_claim_credit_proof_from_awards) — a claim-time
    // concern, not a display one. Surface nothing on the shelf... yet.
    console.warn(`[chain] no proofs for award block ${awardBlock}:`, result.value?.type)
    return []
  }
  const root = Binary.toHex(rootInfo.root)
  const credits: Credit[] = []
  for (const proof of result.value) {
    if (!(proof.credit instanceof Uint8Array)) continue
    const hash = Binary.toHex(proof.credit)
    credits.push({ hash, awardedAt: rootInfo.timestamp, awardBlock, root })
    proofCache.set(hash, proof)
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
  const awards = (await api.query.Game.NftClaimCreditAwards.getValue(awardBlock, AT)) as
    | { claimant: unknown; credit: Uint8Array }[]
    | undefined
  if (!Array.isArray(awards)) return []
  const credits: Credit[] = []
  for (const award of awards) {
    if (!isSamePlayer(award.claimant, identity)) continue
    if (!(award.credit instanceof Uint8Array)) continue
    credits.push({ hash: Binary.toHex(award.credit), awardBlock })
  }
  return credits
}

/** All credits awarded to this player, newest first: rooted blocks via
 *  the runtime APIs (with proofs cached), the rootless newest block via
 *  the awards buffer. */
export async function fetchCredits(api: PeopleApi, identity: PlayerIdentity): Promise<Credit[]> {
  const who = ownerKey(identity)
  const [blocks, roots] = await Promise.all([
    api.query.Game.NftClaimCreditBlocks.getValue(who, AT) as Promise<(number | bigint)[]>,
    api.apis.PalletGameApi.nft_claim_credit_roots(who, AT) as Promise<
      [number | bigint, { root: Uint8Array; timestamp: number }][]
    >
  ])
  const rooted = new Map<number, { root: Uint8Array; timestamp: number }>()
  for (const [block, info] of roots ?? []) rooted.set(Number(block), info)
  const rootless = (blocks ?? []).map(Number).filter((b) => !rooted.has(b))

  const batches = await Promise.all([
    ...[...rooted.entries()].map(([block, info]) => creditsOfRootedBlock(api, who, block, info)),
    ...rootless.map((block) => creditsOfRootlessBlock(api, identity, block))
  ])
  return batches
    .flat()
    .sort((a, b) => (b.awardedAt ?? Number.MAX_SAFE_INTEGER) - (a.awardedAt ?? Number.MAX_SAFE_INTEGER))
}
