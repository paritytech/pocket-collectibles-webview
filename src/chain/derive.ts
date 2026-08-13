// The account deriver: turns the purse convention into addresses.
//
/*
* TEMPORARY SOLUTION TO OPEN QUESTION
* DEPENDENCY #5
* https://github.com/paritytech/scarcity-spa/blob/main/docs/DEPENDENCIES.md
*
* The derivation path convention below is our own interim decision, and
* the in-page DEV_PHRASE key source stands in for the host's
* public-key-at-an-index capability, which has no implementation yet.
*
*/
//
// CONVENTION (interim, NOT platform-ratified — open dependency #5 in
// DEPENDENCIES.md): the player's i-th collectible purse is derived from
// their root key at
//
//     //nft//<i>                           (sr25519 hard derivation)
//
// This is the retreat scarcity-tools web-demo's convention, adopted
// 2026-08-11 (replacing our 2026-08-07 `//product//scarcity//nft//<i>`)
// so both in-house minting surfaces target the same purses — items the
// retreat pipeline claims land where this shelf scans. If the platform
// ratifies a different rule, pursePath() is the only line that changes.
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

import { Binary } from 'polkadot-api'
import { sr25519CreateDerive } from '@polkadot-labs/hdkd'
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from '@polkadot-labs/hdkd-helpers'
import { pubkeyHexOf } from './ss58'

/** The purse convention. Index -> derivation path. */
export function pursePath(index: number): string {
  return `//nft//${index}`
}

/** Public key for the purse at `index`. The production seam: a host
 *  implementation must answer WITHOUT exposing any secret to the page. */
export type KeyAtIndex = (index: number) => Uint8Array

// The DEV_PHRASE deriver, built once. mnemonic -> entropy -> mini-secret
// is real key-stretching work; the scan used to redo it for every single
// address, every poll. This is also the ONE construction site to swap
// when the host's key capability (dependency #5) replaces in-page
// derivation.
let deriver: ((path: string) => { publicKey: Uint8Array }) | null = null
function devDerive(path: string): { publicKey: Uint8Array } {
  if (!deriver) deriver = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)))
  return deriver(path)
}

// Derivations are pure — memoize path -> address so repeat polls over the
// same purse window cost map lookups, not sr25519 work.
const addressCache = new Map<string, string>()
function devAddressOfPath(path: string): string {
  let address = addressCache.get(path)
  if (!address) {
    address = ss58Address(devDerive(path).publicKey, 42)
    addressCache.set(path, address)
  }
  return address
}

/** Dev-only key source: derives from the public dev mnemonic in-page.
 *  Matches scarcity-tools' devAccount() derivation, so purses line up
 *  with what the team's own tooling would mint into. `rootPath` picks the
 *  owner: '' is the bare dev-player root (the gallery's default shelf),
 *  '//Bob' is dev Bob's subtree. */
export function devKeyAtIndex(rootPath = ''): KeyAtIndex {
  return (index) => devDerive(`${rootPath}${pursePath(index)}`).publicKey
}

/** Dev-only: the address at `path` from the dev mnemonic ('' = the bare
 *  dev-player root the default shelf derives from, '//Bob' = dev Bob). */
export function devAddressAt(path = ''): string {
  return devAddressOfPath(path)
}

/** The well-known dev identities every Substrate tool means by "bob". */
const DEV_NAMES = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'] as const

/** Dev-only: the DEV_PHRASE address of a well-known name (case-insensitive
 *  "bob", "Alice", …), or undefined when the input is not one — so callers
 *  can accept a name OR a real address in the same input. */
export function devAddressOf(input: string): string | undefined {
  const name = input.trim().toLowerCase() as (typeof DEV_NAMES)[number]
  if (!DEV_NAMES.includes(name)) return undefined
  const cased = name[0].toUpperCase() + name.slice(1)
  return devAddressOfPath(`//${cased}`)
}

/** One purse address of a dev-held root ('' = dev player, '//Bob'). */
export function devPurseAddress(rootPath: string, index: number): string {
  return devAddressOfPath(`${rootPath}${pursePath(index)}`)
}

// Public-key hex -> dev root path, for every root the page can derive
// purses from: the bare dev player and the full 26-name roster. Built
// lazily; 27 derivations, once.
let devRootIndex: Map<string, string> | null = null
const ALL_DEV_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Dave', 'Eve', 'Ferdie', 'George', 'Heidi',
  'Ivan', 'Judy', 'Kevin', 'Laura', 'Mallory', 'Niaj', 'Olivia', 'Peggy',
  'Quentin', 'Rupert', 'Sybil', 'Trent', 'Ursula', 'Victor', 'Walter',
  'Xavier', 'Yvonne', 'Zack'
]

/** Dev-only: which dev-held root an address belongs to — '' for the bare
 *  dev player, '//Bob' for roster roots — or null when it is nobody we
 *  hold a secret for (an arbitrary address: purse derivation impossible,
 *  by design — production purses come from the host, dependency #5). */
export function devRootPathOf(address: string): string | null {
  const key = pubkeyHexOf(address)
  if (!key) return null
  if (!devRootIndex) {
    devRootIndex = new Map([[Binary.toHex(devDerive('').publicKey), '']])
    for (const name of ALL_DEV_NAMES) {
      devRootIndex.set(Binary.toHex(devDerive(`//${name}`).publicKey), `//${name}`)
    }
  }
  return devRootIndex.get(key) ?? null
}

