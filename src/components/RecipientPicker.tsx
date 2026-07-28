import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import type { CollectibleEntry } from '../collectibles/format'
import { EASE, prefersReducedMotion } from '../anim/easings'
import { haptic } from '../haptics/engine'

interface RecipientPickerProps {
  entry: CollectibleEntry
  onPick: (username: string) => void
  onClose: () => void
}

/** People Chain-style usernames: lowercase handle + numeric suffix. */
const USERNAME_RE = /^[a-z0-9-]+\.\d{1,4}$/

// MOCK directory. PRODUCTION: recent recipients come from native (the
// address book / chat contacts live there), and a typed username resolves
// through the People Chain identity registry (usernameOwnerOf) — the page
// only ever handles the display handle; native maps it to an address and
// signs. The bridge request carries the handle in `recipient`.
const RECENT_CONTACTS = ['quartzwilds.18', 'lumenfox.03', 'pebblewrit.55', 'mosscairn.07']

/** Bottom sheet for choosing who receives the item: recent contacts plus
 *  lookup by username. */
export default function RecipientPicker({ entry, onPick, onClose }: RecipientPickerProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () => RECENT_CONTACTS.filter((c) => !q || c.includes(q)),
    [q]
  )
  // A well-formed username that isn't a known contact is offered as a
  // lookup result — the mock "finds" every valid handle. PRODUCTION: this
  // row would confirm against the identity registry and show a not-found
  // state for handles nobody owns.
  const lookup = q && USERNAME_RE.test(q) && !matches.includes(q) ? q : null
  const nothing = q.length > 0 && matches.length === 0 && !lookup

  useEffect(() => {
    if (prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      gsap.from(scrimRef.current, { opacity: 0, duration: 0.25, ease: EASE.entranceSoft })
      gsap.from(sheetRef.current, { y: '100%', duration: 0.45, ease: EASE.entranceSoft })
    }, sheetRef)
    return () => ctx.revert()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = (username: string) => {
    haptic.initFromGesture()
    haptic.play('tap-store')
    onPick(username)
  }

  return (
    <div className="picker" role="dialog" aria-modal="true" aria-label="Send to">
      <div className="picker-scrim" ref={scrimRef} onClick={onClose} />
      <div className="picker-sheet" ref={sheetRef}>
        <div className="picker-grip" aria-hidden="true" />
        <h2 className="picker-title">Send {entry.resolved.name} to…</h2>
        <div className="collection-search recipient-search">
          <span className="collection-search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            className="collection-search-input"
            placeholder="Find someone by username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Recipient username"
            autoFocus
          />
        </div>
        <div className="picker-rows recipient-rows">
          {matches.map((c) => (
            <button key={c} type="button" className="picker-row" onClick={() => pick(c)}>
              <span className="recipient-avatar" aria-hidden="true">{c[0]!.toUpperCase()}</span>
              <span className="picker-row-text">
                <span className="picker-row-label">{c}</span>
                <span className="picker-row-blurb">Recent</span>
              </span>
            </button>
          ))}
          {lookup && (
            <button type="button" className="picker-row" onClick={() => pick(lookup)}>
              <span className="recipient-avatar" aria-hidden="true">@</span>
              <span className="picker-row-text">
                <span className="picker-row-label">{lookup}</span>
                <span className="picker-row-blurb">Send to this username</span>
              </span>
            </button>
          )}
          {nothing && (
            <p className="recipient-none" role="status">
              No one by that name — usernames look like <b>byteboro.42</b>.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
