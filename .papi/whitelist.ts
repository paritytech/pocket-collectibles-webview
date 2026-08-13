// Descriptor whitelist — keeps the generated @polkadot-api/descriptors
// package (and with it the single-file bundle) down to the entries the
// core read path actually uses. `papi generate` picks this file up
// automatically; add entries here BEFORE coding against new pallet
// surfaces (e.g. tx.NftClaims.claim for Phase 2), then `npm run
// chain:update`.

import type {
  GamingnetAssetHubWhitelistEntry,
  GamingnetPeopleWhitelistEntry
} from '@polkadot-api/descriptors'

export const whitelist: (GamingnetAssetHubWhitelistEntry | GamingnetPeopleWhitelistEntry)[] = [
  // Asset Hub: owned items + three-level metadata (pallets/scarcity.ts)
  'query.Scarcity.NftsByOwner',
  'query.Scarcity.InstanceMetadata',
  'query.Scarcity.ItemMetadata',
  'query.Scarcity.CollectionMetadata',
  // Asset Hub: claim state (pallets/claims.ts)
  'query.NftClaims.CreditTrees',
  'query.NftClaims.ClaimedCredits',
  // Asset Hub: Phase-2 staging, no reader yet — the claim flow's
  // collection picker needs the registered collections and their item
  // counts (kept whitelisted so the descriptors are ready).
  'query.NftClaims.CollectionMinters',
  'query.Scarcity.Collections',
  // People Chain: earned credits + proofs (pallets/credits.ts)
  'query.NftCredits.NftClaimCreditBlocks',
  'query.NftCredits.NftClaimCreditAwards',
  'api.NftCreditsApi.nft_claim_credit_roots',
  'api.NftCreditsApi.nft_claim_credit_proofs'
]
