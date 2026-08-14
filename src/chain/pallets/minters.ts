// The mint flow's collection picker source (Asset Hub).
//
// A credit is spent into a COLLECTION the player chooses; only collections
// whose owner opted in via `NftClaims.set_collection_minter` accept claims,
// and they are exactly the keys of `NftClaims.CollectionMinters`. Each entry
// names how the item is chosen (Random | Contract) — for Random the item is
// the credit modulo the collection's item count, so the preview is exact
// (pallets/preview.ts). Display names come from collection metadata, resolved
// in one metadata_batch; a collection without a name is shown as its id.

import { Enum } from 'polkadot-api'
import { metadataBatch, resolveDisplay } from './scarcity'
import type { AssetHubApi } from '../client'

const AT = { at: 'best' } as const

/** A collection the player may spend a credit into. */
export interface MintCollection {
  id: number
  /** Collection metadata `name`, when set (else the UI shows "Collection <id>"). */
  name?: string
  /** How a claim picks the item — Random is deterministic and previewable. */
  selection: 'random' | 'contract'
}

/** Every collection registered to accept claims, id-sorted, with names
 *  resolved. One storage read for the registrations, one metadata_batch for
 *  the names. */
export async function fetchMintCollections(api: AssetHubApi): Promise<MintCollection[]> {
  const entries = await api.query.NftClaims.CollectionMinters.getEntries(AT)
  const collections: MintCollection[] = entries
    .map((e) => ({
      id: e.keyArgs[0],
      selection: e.value.selection.type === 'Contract' ? ('contract' as const) : ('random' as const)
    }))
    .sort((a, b) => a.id - b.id)
  if (collections.length === 0) return []

  const layers = await metadataBatch(api, collections.map((c) => Enum('Collection', c.id)))
  return collections.map((c, i) => {
    const name = resolveDisplay(layers[i]).name
    return name ? { ...c, name } : c
  })
}
