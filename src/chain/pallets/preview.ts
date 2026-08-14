// The mint flow's preview (Asset Hub).
//
// Before a credit is spent, `NftClaimsApi.preview_mints` runs the REAL claim
// selector for a batch of (credit, collection) pairs and returns, positionally,
// what each would mint — an item index (with how it was selected) or a reason
// it can't. For Random collections the selection is deterministic (item =
// credit mod the collection's item count), so the preview IS the eventual
// mint: switching collection is the only way to change the outcome, which is
// exactly the picker's UX. Mints outcomes get their item's name/image resolved
// through the same metadata path the shelf uses (pallets/scarcity.ts); a
// collection with no item metadata (the testnet's registered ones today) has
// no name/image, and the UI falls back to a placeholder.

import { Enum } from 'polkadot-api'
import { metadataBatch, resolveDisplay } from './scarcity'
import type { AssetHubApi } from '../client'

const AT = { at: 'best' } as const

type PreviewQuery = Parameters<AssetHubApi['apis']['NftClaimsApi']['preview_mints']>[0][number]

/** What claiming one credit into one collection would mint. */
export interface MintPreview {
  collection: number
  outcome:
    | { kind: 'mints'; item: number; via: 'random' | 'contract'; name?: string; imageUrl?: string }
    | { kind: 'fails'; reason: string }
}

/** Preview `credit` against each of `collections`, in one runtime call, with
 *  the Mints outcomes' names/images resolved in one metadata_batch. Throws
 *  only if the runtime refuses the whole batch (oversized) — a per-query
 *  failure is a `fails` outcome, not an error. */
export async function previewMints(
  api: AssetHubApi,
  credit: string,
  collections: number[]
): Promise<MintPreview[]> {
  if (collections.length === 0) return []
  const creditHex = credit.startsWith('0x') ? credit : `0x${credit}`
  const queries = collections.map(
    (collection) => ({ credit: creditHex, collection }) as PreviewQuery
  )
  const result = await api.apis.NftClaimsApi.preview_mints(queries, AT)
  if (!result.success) {
    throw new Error(`preview_mints refused the batch (${result.value.type})`)
  }
  const outcomes = result.value

  // Resolve item metadata for the Mints outcomes in one batch.
  const targets = outcomes.flatMap((o, i) =>
    o.type === 'Mints' ? [{ i, collection: collections[i], item: o.value.item }] : []
  )
  const layers = targets.length
    ? await metadataBatch(api, targets.map((t) => Enum('Item', { collection: t.collection, item: t.item })))
    : []
  const display = new Map<number, { name?: string; imageUrl?: string }>()
  targets.forEach((t, k) => display.set(t.i, resolveDisplay(layers[k])))

  return outcomes.map((o, i) => {
    if (o.type === 'Mints') {
      return {
        collection: collections[i],
        outcome: {
          kind: 'mints',
          item: o.value.item,
          via: o.value.via.type === 'Contract' ? 'contract' : 'random',
          ...(display.get(i) ?? {})
        }
      }
    }
    return { collection: collections[i], outcome: { kind: 'fails', reason: o.value.reason.type } }
  })
}
