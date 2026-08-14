// The dev purse source: in-page DEV_PHRASE derivation over derive.ts.
// Used outside any host, and (TEMPORARILY) as the container stand-in while
// no host build implements product accounts — see purses.ts for the
// interface and the host source.

import { devPurseAddress } from './derive'
import type { PurseSource } from './purses'

/** Dev source: in-page DEV_PHRASE derivation, '' = the bare dev-player
 *  root, '//Bob' = dev Bob's subtree. cacheKey stays the root path, so
 *  existing scan caches remain valid. */
export function devPurseSource(rootPath: string): PurseSource {
  return {
    cacheKey: rootPath,
    addressAt: (index) => Promise.resolve(devPurseAddress(rootPath, index))
  }
}
