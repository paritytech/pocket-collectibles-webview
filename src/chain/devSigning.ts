// The dev signer source: an in-page PolkadotSigner for a dev-held identity,
// derived from DEV_PHRASE (derive.ts). DEV/QA ONLY — production signs through
// the host (signing.ts, which asks the host to sign as its product account).
// It exists so the mint flow can spend a credit under ?player=alice on the
// testnet; a real host account isn't dev-derivable, so this returns null and
// signing.ts falls through to the host path.

import type { PolkadotSigner } from 'polkadot-api/signer'
import type { PlayerIdentity } from './identity'
import { devSignerForAddress } from './derive'

/** A dev signer for the claimant, or null when the identity isn't a
 *  dev-held account (an alias, or a real host account we hold no secret for). */
export function devSignerFor(identity: PlayerIdentity): PolkadotSigner | null {
  if (identity.kind !== 'account') return null
  return devSignerForAddress(identity.address)
}
