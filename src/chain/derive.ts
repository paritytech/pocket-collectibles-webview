// The account deriver: turns the purse convention into addresses.
//
// CONVENTION (interim, decided by us 2026-08-07, NOT platform-ratified —
// open dependency #5 in DEPENDENCIES.md): the player's i-th collectible
// purse is derived from their root key at
//
//     //product//scarcity//nft//<i>        (sr25519 hard derivation)
//
// modelled on the platform's observed product-subtree pattern
// (`//product//dim2.dot/0`). If the platform ratifies a different rule,
// PURSE_PATH is the only line that changes.
//
// Key material: the page holds no secrets (design doc §3.7), so the
// deriver works through a `KeyAtIndex` capability that yields PUBLIC keys
// only:
//   - production: the host must supply "a public key at an index" — a
//     documented Phase-1 read capability that has NO host implementation
//     yet; when the bridge exists it slots in here.
//   - dev (not embedded): keys derive in-page from DEV_PHRASE, the public
//     Substrate dev mnemonic — testnet-only by construction, and the same
//     root the scarcity-tools web-demo uses.
//
// Scan policy (also ours, undocumented anywhere): derive a fixed window
// of indexes and hand them all to the reader — NftsByOwner reads are
// batched, so a window costs one round trip and empty purses simply
// return nothing. Gap-limit scanning can replace this if windows get big.

import { sr25519CreateDerive } from '@polkadot-labs/hdkd'
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from '@polkadot-labs/hdkd-helpers'

/** The purse convention. Index -> derivation path. */
export function pursePath(index: number): string {
  return `//product//scarcity//nft//${index}`
}

/** How many purse indexes to derive and read per poll. Stays under
 *  start.ts's MAX_ACCOUNTS (100); one batched read either way. */
export const PURSE_WINDOW = 64

/** Public key for the purse at `index`. The production seam: a host
 *  implementation must answer WITHOUT exposing any secret to the page. */
export type KeyAtIndex = (index: number) => Uint8Array

/** Dev-only key source: derives from the public dev mnemonic in-page.
 *  Matches scarcity-tools' devAccount() derivation, so purses line up
 *  with what the team's own tooling would mint into. */
export function devKeyAtIndex(): KeyAtIndex {
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)))
  return (index) => derive(pursePath(index)).publicKey
}

/** The derived purse addresses (SS58, generic prefix 42), one per index
 *  in the window. */
export function deriveAddresses(keyAt: KeyAtIndex, window = PURSE_WINDOW): string[] {
  const addresses: string[] = []
  for (let index = 0; index < window; index++) {
    try {
      addresses.push(ss58Address(keyAt(index), 42))
    } catch (err) {
      console.warn(`[chain] purse derivation failed at index ${index}`, err)
      break
    }
  }
  return addresses
}
