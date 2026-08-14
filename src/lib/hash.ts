// Hash-identity helpers shared by the chain layer, the bridge store and
// the view models. One definition of "normalized hash" — before this,
// four hand-rolled copies (regex vs prefix-pair vs trim variants) had
// already drifted, and a mismatch between any two turns into "credit
// doesn't match its item" bugs.

/** Normalize a hash to the canonical comparison/storage form: trimmed,
 *  no 0x prefix, lowercase. Works for synthetic identities too
 *  ("instance-42" passes through lowercased). */
export function normalizeHash(hash: string): string {
  const h = hash.trim()
  return (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h).toLowerCase()
}

/** Compact, distinctive serial for display: two 4-char groups from the
 *  head + tail of the hash, uppercased ("7F3A·9C2B"). Stable per hash.
 *  Synthetic identities (hashless items keyed "instance-<id>") pass
 *  through whole so every item keeps a distinct code. */
export function shortCode(hash: string): string {
  const h = normalizeHash(hash).toUpperCase()
  if (!/^[0-9A-F]+$/.test(h)) return h
  if (h.length < 8) return h
  return `${h.slice(0, 4)}·${h.slice(-4)}`
}
