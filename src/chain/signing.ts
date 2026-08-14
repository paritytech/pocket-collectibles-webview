// Who signs the mint claim — one seam, two key sources, mirroring purses.ts
// and identity.ts.
//
//   DEV — an in-page DEV_PHRASE signer (devSigning.ts), for plain-browser and
//   ?player= QA sessions. Only answers for keys we hold, so a real host
//   account falls through to the host path below.
//   CONTAINER — the host signs as the product account (the claimant is product
//   account 0, shared with identity.ts) via the SDK AccountsProvider's
//   getProductAccountSigner. This IS implemented in shipping hosts — the iOS
//   app (accountGet + signPayload) and desktop (RFC-0022 product subtree
//   derivation) both do it. What gates it for us is a REAL registered DotNS
//   product id: the host derives the account from `DOTNS_IDENTIFIER`'s subtree,
//   and ours is still a placeholder (dependency #1, chain/product.ts). Until
//   that id is registered — or in a host that doesn't serve it (e.g. the
//   Polkadot Browser we first probed) — getProductAccount fails and the caller
//   gets null.
//
// A session that cannot sign (an unregistered product id / a host without the
// capability, or an alias identity — Person claims aren't built, dependency
// #2/#3) yields null, and the UI hides the mint action rather than offering a
// dead button.

import { getAccountsProvider } from '@parity/product-sdk-host'
import type { PolkadotSigner } from 'polkadot-api/signer'
import { isInContainer } from '../host/embed'
import { DOTNS_IDENTIFIER } from './product'
import type { PlayerIdentity } from './identity'
import { devSignerFor } from './devSigning'

/** A signer for the claimant, or null when this session can't sign. Person
 *  aliases (dependency #2/#3) aren't built — only account claimants sign. */
export async function getSigner(identity: PlayerIdentity | null): Promise<PolkadotSigner | null> {
  if (!identity || identity.kind !== 'account') return null

  // A dev-held identity signs in-page: a plain-browser session, or a ?player=
  // QA override inside a host. devSignerFor answers only for keys derivable
  // from DEV_PHRASE, so a real host product account returns null here and
  // falls through to the host path.
  const devSigner = devSignerFor(identity)
  if (devSigner) return devSigner

  // Otherwise ask the host to sign as its product account (index 0 — the same
  // account identity.ts resolves the player to). Returns null when the host
  // lacks product accounts or the DotNS id isn't registered (dependency #1);
  // the claim button then stays hidden.
  if (isInContainer) {
    const provider = await getAccountsProvider()
    if (provider) {
      const account = await provider
        .getProductAccount(DOTNS_IDENTIFIER, 0)
        .match((a) => a, () => null)
      if (account) return provider.getProductAccountSigner(account)
    }
  }
  return null
}
