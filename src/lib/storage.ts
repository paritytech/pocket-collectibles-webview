// localStorage JSON helpers with one degradation policy. Some WebView
// configurations block storage entirely and quota errors happen — every
// caller wants the same answer: reads fall back to null, writes and
// removals fail silently. Previously re-implemented per module.

/** Parsed JSON at `key`, or null when absent, unparsable, or storage is
 *  unavailable. Callers re-validate the shape — a tampered or legacy
 *  payload must degrade, never crash. */
export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** Persist `value` as JSON at `key`; silently a no-op when storage is
 *  unavailable or full. */
export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — callers treat persistence as best-effort */
  }
}

/** Remove `key`; silently a no-op when storage is unavailable. */
export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
