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
  // Asset Hub: owned items + all three metadata layers in one batched
  // runtime call (pallets/scarcity.ts). metadata_batch also serves the
  // mint flow's Item/Collection preview metadata (pallets/preview.ts,
  // pallets/minters.ts).
  'query.Scarcity.NftsByOwner',
  'api.ScarcityApi.metadata_batch',
  // Asset Hub: claim state (pallets/claims.ts)
  'query.NftClaims.CreditTrees',
  'query.NftClaims.ClaimedCredits',
  // Asset Hub: the mint flow — the collection picker reads the registered
  // collections (pallets/minters.ts), the preview asks the runtime what a
  // credit would mint into each (api NftClaimsApi.preview_mints,
  // pallets/preview.ts), and the claim spends the credit (chain/claim.ts).
  'query.NftClaims.CollectionMinters',
  'query.Scarcity.Collections',
  'api.NftClaimsApi.preview_mints',
  'tx.NftClaims.claim',
  // Asset Hub: the send flow — moving an owned item to another player's
  // purse is `Scarcity.transfer`, signed by the sending purse-key origin
  // (chain/transfer.ts, chain/start.ts sendItem).
  'tx.Scarcity.transfer',
  // People Chain: earned credits + proofs (pallets/credits.ts)
  'query.NftCredits.NftClaimCreditBlocks',
  'query.NftCredits.NftClaimCreditAwards',
  'api.NftCreditsApi.nft_claim_credit_roots',
  'api.NftCreditsApi.nft_claim_credit_proofs'
]
