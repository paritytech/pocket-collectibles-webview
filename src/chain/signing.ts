// Who signs the mint claim — one seam, two key sources that NEVER overlap.
//
//   CONTAINER (host) — the host signs as the product account (the claimant is
//   product account 0, shared with identity.ts) via the SDK AccountsProvider's
//   getProductAccountSigner. This is implemented by the iOS app (accountGet +
//   signPayload) and desktop (RFC-0022 product subtree). What gates it for us
//   is a REAL registered DotNS product id (dependency #1, chain/product.ts);
//   ours is a placeholder, so getProductAccount fails for now.
//   DEV — an in-page DEV_PHRASE signer (devSigning.ts), for a plain-browser
//   session or an explicit ?player=/?alias= QA override.
//
// HARD RULE: the dev signer is NEVER a fallback for host signing. Its key is
// the public, well-known dev mnemonic — signing a real claim with it inside a
// host would be a security hole. So inside a container (with no explicit dev
// override) ONLY the host may sign; if it can't (unregistered id / a host that
// lacks the capability), getSigner returns null and the UI hides the Reveal
// action rather than reaching for the dev key. The container's dev-derived
// identity/purse stand-in is a read-only display affordance — it never signs.
//
// Person/alias claims aren't built (dependency #2/#3), so only account
// claimants sign.

import { getAccountsProvider } from '@parity/product-sdk-host'
import type { PolkadotSigner } from 'polkadot-api/signer'
import { isInContainer } from '../host/embed'
import { DOTNS_IDENTIFIER } from './product'
import { hasDevOverride } from './devIdentity'
import type { PlayerIdentity } from './identity'
import { devSignerFor } from './devSigning'

/** A signer for the claimant, or null when this session can't sign. */
export async function getSigner(identity: PlayerIdentity | null): Promise<PolkadotSigner | null> {
  if (!identity || identity.kind !== 'account') return null

  // Inside a host container, only the host signs — never the dev key. The one
  // exception is an explicit ?player=/?alias= QA override, which opts the
  // session into dev signing on purpose (handled by the dev path below).
  if (isInContainer && !hasDevOverride()) {
    const provider = await getAccountsProvider()
    if (provider) {
      const account = await provider
        .getProductAccount(DOTNS_IDENTIFIER, 0)
        .match((a) => a, () => null)
      if (account) return provider.getProductAccountSigner(account)
    }
    // Host can't sign → do NOT fall back to the dev key; hide the action.
    return null
  }

  // Plain browser, or an explicit QA override: sign in-page with the dev key.
  // Only answers for dev-held identities, null for anything else.
  return devSignerFor(identity)
}
