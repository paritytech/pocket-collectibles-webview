// A minimal observable value — the subscription scaffold the input seams
// (chain/identity.ts, chain/accounts.ts) share: hold a value, fan out
// changes, call new subscribers immediately with the current value, and
// never let one listener's throw break delivery to the rest. One
// implementation so both seams keep identical delivery guarantees.

export interface Observable<T> {
  /** The current value, synchronously. */
  get(): T
  /** Replace the value and fan it out to every subscriber. */
  set(next: T): void
  /** Calls cb with the current value immediately, then again on every
   *  set(). Returns an unsubscribe function. */
  subscribe(cb: (value: T) => void): () => void
}

export function createObservable<T>(initial: T): Observable<T> {
  let value = initial
  const listeners = new Set<(value: T) => void>()
  return {
    get: () => value,
    set(next: T): void {
      value = next
      for (const cb of listeners) {
        try { cb(value) } catch { /* a listener throwing can't break the channel */ }
      }
    },
    subscribe(cb: (value: T) => void): () => void {
      listeners.add(cb)
      try { cb(value) } catch { /* see set() */ }
      return () => { listeners.delete(cb) }
    }
  }
}
