/** Rejects if `promise` has not settled within `ms`. For awaits that must
 *  never hang forever (wedged sockets, an unresponsive host). */
export function withDeadline<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    promise.then(
      (v) => { window.clearTimeout(t); resolve(v) },
      (e) => { window.clearTimeout(t); reject(e) }
    )
  })
}
