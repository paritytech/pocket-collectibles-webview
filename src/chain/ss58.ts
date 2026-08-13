// SS58 address helpers with one interpretation of polkadot-api's
// getSs58AddressInfo contract (throws on some malformed inputs, returns
// isValid: false on others). Previously re-guessed at four sites.

import { getSs58AddressInfo, Binary } from 'polkadot-api'

/** Whether `address` parses as SS58 (any network prefix). */
export function isValidSs58(address: string): boolean {
  try {
    return getSs58AddressInfo(address).isValid
  } catch {
    return false
  }
}

/** The public key behind an SS58 address as 0x-hex, or null when the
 *  address doesn't parse. Comparing addresses by this is
 *  network-prefix-independent. */
export function pubkeyHexOf(address: string): string | null {
  try {
    const info = getSs58AddressInfo(address)
    return info.isValid ? Binary.toHex(info.publicKey) : null
  } catch {
    return null
  }
}
