import { useEffect, useMemo, useRef, useState } from 'react'
import PhoneFrame from './components/PhoneFrame'
import ParticleCanvas, { type ParticleCanvasApi } from './components/ParticleCanvas'
import GalleryScreen, { EmptyGallery } from './screens/GalleryScreen'
import DetailScreen from './screens/DetailScreen'
import IntroOverlay from './components/IntroOverlay'
import ChestArrival from './components/ChestArrival'
import DevPanel from './components/DevPanel'
import CollectionPicker from './components/CollectionPicker'
import MintCeremony, { type CeremonyEntry } from './components/MintCeremony'
import PostGameFlow from './components/PostGameFlow'
import RecipientPicker from './components/RecipientPicker'
import SendOverlay from './components/SendOverlay'
import ThemeSwitcher from './components/ThemeSwitcher'
import { hasSeenIntro, markIntroSeen } from './firstRun'
import {
  readInitialCollection,
  subscribeCollection,
  hasDelivered,
  getCollectionGeneration,
  getDroppedCount
} from './bridge/collection'
import { sendFlowEvent } from './bridge/send'
import { newRequestId, sendBridgeRequest } from './bridge/requests'
import type { CollectionInput, OwnedNft, Ticket } from './bridge/types'
import { buildEntries, type CollectibleEntry } from './collectibles/format'
import { buildTicketEntries, isTicketExpired, type TicketEntry } from './collectibles/tickets'
import { loadScenario } from './mock/mockNative'
import {
  COLLECTION_SIZES,
  DEV_MOCKS,
  TICKET_SETS,
  composeScenario,
  demoMintTicket,
  type CollectionSizeId,
  type FlavorId,
  type TicketSetId
} from './devMocks'
import { type Rarity } from './collectibles/resolver'
import { shortCode } from './collectibles/format'
import {
  defaultTarget,
  loadFavourites,
  outcomeFor,
  saveFavourites
} from './collectibles/mintCollections'

/** Parse the composed-scenario axis params (?tickets=&collection=&flavors=)
 *  the dev panel mirrors into the URL. Null when none are present. */
function readAxisParams(): { tickets: TicketSetId; collection: CollectionSizeId; flavors: FlavorId[] } | null {
  const q = new URLSearchParams(window.location.search)
  const t = q.get('tickets')
  const c = q.get('collection')
  if (!t && !c) return null
  const tickets = (t && t in TICKET_SETS ? t : 'none') as TicketSetId
  const collection = (c && c in COLLECTION_SIZES ? c : 'typical') as CollectionSizeId
  const flavors = (q.get('flavors') ?? '')
    .split(',')
    .filter((f): f is FlavorId => !!f) as FlavorId[]
  return { tickets, collection, flavors }
}

// If native never delivers a collection, stop waiting after this long rather
// than spinning forever (offline / silent host). What shows then depends on
// the last-known-good cache (bridge/collectionCache.ts): a cached collection
// renders immediately — no boot screen at all — so this timeout only gates
// the first-ever (or storage-blocked) boot, which falls to the empty state.
const BOOT_TIMEOUT_MS = 8_000

// Dev panel shows only with ?dev=1. Mirrors the game-results convention.
const isDevMode =
  typeof window !== 'undefined' && /[?&]dev=1\b/.test(window.location.search)

// "Embedded" = running inside a native WebView host (not a desktop preview).
// CSS flattens the phone-frame mockup when body.is-embedded is set. The mock
// native transport (dev/mock sessions) doesn't count — it exists to exercise
// the bridge, not to signal a real WebView, and the desktop preview should
// keep its phone frame.
const isEmbedded =
  typeof window !== 'undefined' &&
  !(window as unknown as { __MOCK_NATIVE__?: boolean }).__MOCK_NATIVE__ && (
    !!(window as unknown as { collectibles?: unknown }).collectibles ||
    !!window.webkit?.messageHandlers?.collectibles ||
    /[?&]embed=1\b/.test(window.location.search)
  ) ||
  typeof window !== 'undefined' && /[?&]embed=1\b/.test(window.location.search)

interface Selection {
  list: CollectibleEntry[]
  index: number
  originRect: DOMRect
}

interface CeremonyState {
  requestIds: string[]
  /** Snapshot of ticket + chosen item — immune to the collection
   *  replacement that lands underneath mid-ceremony. */
  entries: CeremonyEntry[]
  /** What to do when the ceremony finishes, if it ran inside the guided
   *  post-game flow: 'advance' → back to the flow for the next ticket;
   *  'exit' → the flow is done, land on the collection. Absent = a
   *  standalone mint (just close). */
  after?: 'advance' | 'exit'
}

export default function App() {
  const initial = useMemo(() => readInitialCollection(), [])
  const [items, setItems] = useState<OwnedNft[]>(initial.items)
  const [tickets, setTickets] = useState<Ticket[]>(initial.tickets)
  const [displayName, setDisplayName] = useState<string | undefined>(initial.displayName)
  const [delivered, setDelivered] = useState<boolean>(hasDelivered())
  const [bootTimedOut, setBootTimedOut] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  // Ticket whose choose-your-item sheet is open.
  const [picking, setPicking] = useState<TicketEntry | null>(null)
  // Guided post-game flow: the chest's mintable tickets presented one by
  // one (mint or skip). A snapshot queue — skipped/minted tickets stay
  // consistent even as deliveries change the live shelf underneath.
  const [guided, setGuided] = useState<{ queue: TicketEntry[]; index: number } | null>(null)
  // Dev: 'random' surprises every reveal; 'signature' gives each collection
  // a consistent look (rares always override with the epic charge).
  const [variantMode, setVariantMode] = useState<'signature' | 'random'>('signature')
  // Favourite collections (persisted). The top favourite is the one-click
  // "Mint all" default target.
  const [favourites, setFavourites] = useState<string[]>(() => loadFavourites())
  const [ceremony, setCeremony] = useState<CeremonyState | null>(null)
  // The game→collectibles handoff (?arrival=1): a sealed bundle covers the
  // screen until tapped; opening it replays the gallery entrance so the
  // shelf "arrives". PRODUCTION: native routes here from the game's chest
  // moment — the param mocks that routing.
  const [arrival, setArrival] = useState<boolean>(
    () => /[?&]arrival=1\b/.test(window.location.search)
  )
  const [arrivalGen, setArrivalGen] = useState(0)
  // Send flow: first pick who gets it, then the in-flight overlay.
  const [choosingRecipient, setChoosingRecipient] = useState<CollectibleEntry | null>(null)
  const [sending, setSending] = useState<{ requestId: string; entry: CollectibleEntry; recipient: string } | null>(null)
  // First-run intro — shown once over the first populated gallery view.
  const [showIntro, setShowIntro] = useState(false)
  const introChecked = useRef(false)
  // Remount key for the gallery: bumps only on a wholesale setCollection
  // (new scenario / dev mock), so the entrance — count-up included —
  // replays. Incremental pushNft streaming leaves it untouched.
  const [collectionGen, setCollectionGen] = useState<number>(getCollectionGeneration())

  const particleRef = useRef<ParticleCanvasApi>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const hasFiredReady = useRef(false)
  const reportedDropped = useRef(0)
  const hasFiredGalleryShown = useRef(false)
  const prevCollectionGen = useRef(collectionGen)

  // Resolve raw NFTs → display entries. Memoized so we only re-resolve when
  // the owned set actually changes.
  const entries = useMemo(() => buildEntries(items), [items])
  const ticketEntries = useMemo(() => buildTicketEntries(tickets), [tickets])
  // Always-current entries, so the deferred gallery_shown fire below reports
  // the live count rather than a value captured when the effect first ran.
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  // Subscribe to native collection deliveries (initial + late + streamed).
  useEffect(() => {
    const off = subscribeCollection((next) => {
      setItems(next.items)
      setTickets(next.tickets)
      setDelivered(hasDelivered())
      setCollectionGen(getCollectionGeneration())
      // Surface to native when we capped an oversized delivery (so it learns
      // the user owns more than we render). Only on change, to avoid spam.
      const dropped = getDroppedCount()
      if (dropped > 0 && dropped !== reportedDropped.current) {
        reportedDropped.current = dropped
        sendFlowEvent({ type: 'flow.error', phase: 'collection_truncated', detail: `dropped=${dropped}` })
      }
      // Re-read the name in case it arrived with this delivery.
      const fresh = readInitialCollection()
      if (fresh.displayName) setDisplayName(fresh.displayName)
    })
    return off
  }, [])

  // flow.ready once per page lifetime, after first paint.
  useEffect(() => {
    if (hasFiredReady.current) return
    hasFiredReady.current = true
    sendFlowEvent({ type: 'flow.ready' })
  }, [])

  // Dev convenience: `?mock=<name>` auto-loads a scenario on boot so a
  // populated gallery can be shared / screenshotted via a plain URL.
  // No native required. Matches the first whitespace-delimited word of a
  // DEV_MOCKS label (e.g. ?mock=typical, ?mock=rare, ?mock=collector).
  useEffect(() => {
    // Composed axis params (from the dev panel's shareable URLs) win…
    const axes = readAxisParams()
    if (axes) {
      loadScenario(composeScenario(axes.tickets, axes.collection, axes.flavors))
      return
    }
    // …else the legacy ?mock= aliases still work.
    const param = new URLSearchParams(window.location.search).get('mock')
    if (!param) return
    const mock = DEV_MOCKS.find((m) => m.label.toLowerCase().startsWith(param.toLowerCase()))
    if (!mock) return
    // Route through the mock native so it can mirror the scenario and arm
    // ticket state flips — the same path a real delivery would take.
    loadScenario(mock.build())
  }, [])

  // Tag <body> when embedded so CSS flattens the desktop phone frame.
  useEffect(() => {
    if (!isEmbedded) return
    document.body.classList.add('is-embedded')
    return () => { document.body.classList.remove('is-embedded') }
  }, [])

  // Boot timeout — only relevant before any delivery. The detail tells
  // native whether the user was covered by the cached collection or left
  // on the empty state.
  useEffect(() => {
    if (delivered) return
    const t = window.setTimeout(() => {
      sendFlowEvent({
        type: 'flow.error',
        phase: 'boot_timeout',
        detail: entriesRef.current.length > 0 ? 'showing_cached' : 'no_cache'
      })
      setBootTimedOut(true)
    }, BOOT_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [delivered])

  // Ambient starfield behind everything, for the whole session.
  useEffect(() => {
    particleRef.current?.startAmbient()
    return () => particleRef.current?.stopAmbient()
  }, [])

  // Asset-failure telemetry. Image-load failures (most likely expired
  // Bulletin Chain CIDs) accumulate on window.__ASSET_FAILURES__ as tiles
  // load lazily. Poll and emit a debounced rollup — only when the count
  // grows — so native learns "art isn't loading" without one event per
  // image. Cheap (a number read every few seconds) for the session.
  useEffect(() => {
    if (!delivered) return
    let reported = 0
    const id = window.setInterval(() => {
      const n = (window as unknown as { __ASSET_FAILURES__?: number }).__ASSET_FAILURES__ ?? 0
      if (n > reported) {
        reported = n
        sendFlowEvent({ type: 'flow.error', phase: 'assets', detail: `image_failures=${n}` })
      }
    }, 4000)
    return () => window.clearInterval(id)
  }, [delivered])

  // flow.gallery_shown — fired once, the first time the populated gallery is
  // shown. Deferred one frame so a burst of pushNft items arriving in the
  // same tick as the first render is counted (the bridge coalesces notifies
  // into a microtask; a frame lands safely after), and reports the LIVE count
  // via entriesRef rather than a value captured at the gallery's mount —
  // which undercounted while items were still streaming.
  useEffect(() => {
    if (hasFiredGalleryShown.current) return
    if (!delivered || entries.length === 0) return
    hasFiredGalleryShown.current = true
    const id = requestAnimationFrame(() => {
      sendFlowEvent({ type: 'flow.gallery_shown', count: entriesRef.current.length })
    })
    return () => cancelAnimationFrame(id)
  }, [delivered, entries.length])

  // First-run intro: show once, the first time a populated gallery is
  // available. Gated on localStorage (firstRun.ts); if storage is
  // unavailable it simply reshows, which is harmless (skippable). Skipped
  // entirely for an empty collection — there's nothing to introduce yet.
  useEffect(() => {
    if (introChecked.current) return
    if (!delivered || entries.length === 0) return
    introChecked.current = true
    // QA override: `?intro=1` forces it, `?intro=0` suppresses it — otherwise
    // it's the first-run localStorage gate.
    const forced = new URLSearchParams(window.location.search).get('intro')
    if (forced === '0') return
    if (forced === '1' || !hasSeenIntro()) setShowIntro(true)
  }, [delivered, entries.length])

  // A wholesale setCollection (generation bump) replaces the gallery behind
  // an open detail view; the detail holds a snapshot of the OLD list and
  // would keep navigating now-stale/removed items. Close it on replace.
  // Incremental pushNft never bumps the generation, so streaming updates
  // don't dismiss an open detail.
  useEffect(() => {
    if (prevCollectionGen.current === collectionGen) return
    prevCollectionGen.current = collectionGen
    setSelection(null)
  }, [collectionGen])

  function handleOpen(list: CollectibleEntry[], index: number, originRect: DOMRect): void {
    const entry = list[index]
    if (!entry) return
    // Spectacle on open is a rare-only flourish — common items open clean.
    // The particle canvas lives inside the phone frame, so translate the
    // tile's viewport-space center into frame-local coordinates (identity
    // when embedded full-screen; corrects for the centered frame in
    // desktop preview).
    if (entry.resolved.isRare) {
      const frame = frameRef.current?.getBoundingClientRect()
      const cx = originRect.left + originRect.width / 2 - (frame?.left ?? 0)
      const cy = originRect.top + originRect.height / 2 - (frame?.top ?? 0)
      particleRef.current?.sparkleBurst(cx, cy)
    }
    setSelection({ list, index, originRect })
  }

  function handleClose(): void {
    const cur = selection ? selection.list[selection.index] : null
    if (cur) sendFlowEvent({ type: 'flow.item_closed', hash: cur.hashHex })
    setSelection(null)
  }

  function handleShow(hash: string): void {
    sendFlowEvent({ type: 'flow.item_opened', hash: hash.startsWith('0x') ? hash : `0x${hash}` })
  }

  /** Mint the item the player chose for a ticket (choose-your-item).
   *
   *  PRODUCTION: everything after sendBridgeRequest is native's show —
   *  approval sheet (PGAS-sponsored, no fee), merkle proof, signing,
   *  Asset Hub claim submission — streamed back as RequestUpdates and
   *  finished with a wholesale setCollection of the new chain truth. */
  /** Step the guided post-game flow forward; leaving the last ticket (or
   *  skipping all) lands on the collection with a fresh entrance. */
  function advanceGuided(): void {
    setGuided((g) => {
      if (!g) return null
      const next = g.index + 1
      if (next >= g.queue.length) {
        setArrivalGen((n) => n + 1)
        return null
      }
      return { ...g, index: next }
    })
  }

  function exitGuided(): void {
    setGuided(null)
    setArrivalGen((n) => n + 1)
  }

  /** The one-click default mint target: the top favourite, else the
   *  governance default collection. */
  const mintTarget = defaultTarget(favourites)

  function toggleFavourite(id: string): void {
    setFavourites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev]
      saveFavourites(next)
      return next
    })
  }

  /** Fire a batch mint: every ticket claims into `collectionId`, one
   *  request, one batch ceremony (the wave). Each ticket's item is derived
   *  deterministically from its credit hash + the collection. `after`
   *  coordinates with the guided post-game flow. */
  function mintInto(tickets: TicketEntry[], collectionId: string, after?: 'advance' | 'exit'): void {
    if (ceremony) return
    const mintable = tickets.filter((t) => t.state === 'mintable')
    if (mintable.length === 0) return
    const mints = mintable.map((t) => ({ ticketHash: t.hashHex, collectionId }))
    const snapshot: CeremonyEntry[] = mintable.map((t) => ({
      hash: t.hash, shortCode: t.shortCode, collectionId,
      preview: outcomeFor(t.hash, t.rarity, collectionId)
    }))
    const requestId = newRequestId()
    sendBridgeRequest({ type: 'request.mint', requestId, mints })
    setPicking(null)
    setArrival(false)
    setCeremony({ requestIds: [requestId], entries: snapshot, ...(after ? { after } : {}) })
  }

  /** One-click "Mint all" — the primary path. Everything into the default
   *  target collection at once. From the post-game flow it ends the flow. */
  function mintAll(tickets: TicketEntry[]): void {
    mintInto(tickets, mintTarget, guided ? 'exit' : undefined)
  }

  /** Send: the recipient sheet resolves WHO (recent contact or username
   *  lookup), the request carries the handle, and the SendOverlay rides
   *  the update stream. The post-transfer truth delivery removes the item
   *  and closes the stale detail view via the generation bump. */
  function startSend(entry: CollectibleEntry): void {
    if (sending || choosingRecipient) return
    setChoosingRecipient(entry)
  }

  function sendTo(entry: CollectibleEntry, recipient: string): void {
    const requestId = newRequestId()
    sendBridgeRequest({ type: 'request.send', requestId, itemHash: entry.hashHex, recipient })
    setChoosingRecipient(null)
    setSending({ requestId, entry, recipient })
  }

  /** UJ-6: ask native to deep-link into the item's game. Fire-and-mostly-
   *  forget — native suspends the webview when it routes; the detail view
   *  just shows a brief "opening…" note. */
  function openGame(entry: CollectibleEntry): void {
    if (!entry.gameLink) return
    sendBridgeRequest({ type: 'request.open_game', requestId: newRequestId(), url: entry.gameLink.url })
  }

  /** Dev shortcut: jump straight to the reveal ceremony with a guaranteed
   *  rare or common outcome, to compare the two experiences instantly. */
  function demoMint(rarity: Rarity): void {
    if (ceremony) return
    const { ticketHash } = demoMintTicket(rarity)
    const hash = (ticketHash.startsWith('0x') ? ticketHash.slice(2) : ticketHash).toLowerCase()
    const collectionId = mintTarget
    const preview = outcomeFor(hash, rarity, collectionId)
    const requestId = newRequestId()
    sendBridgeRequest({ type: 'request.mint', requestId, mints: [{ ticketHash, collectionId }], demo: true })
    setPicking(null)
    setArrival(false)
    setGuided(null)
    setCeremony({
      requestIds: [requestId],
      entries: [{ hash, shortCode: shortCode(hash), collectionId, preview }]
    })
  }

  // Dev helper: load a composed scenario through the mock native (mirrors
  // the scenario + arms ticket flips). setCollection replaces the store
  // wholesale and notifies subscribers, so no resetCollection() is needed
  // here — and calling it would be wrong, as it clears the listener set
  // (including this component's own subscription).
  function loadDevScenario(input: CollectionInput): void {
    setSelection(null)
    setCeremony(null)
    setSending(null)
    setPicking(null)
    // A new scenario dismisses a lingering chest / guided flow — otherwise
    // overlays from a previous state sit on top of every state after it.
    setArrival(false)
    setGuided(null)
    loadScenario(input)
  }

  // Boot screen only while there's nothing to show: cache-seeded entries
  // render at once even though native hasn't spoken yet.
  const showBoot = !delivered && !bootTimedOut && entries.length === 0 && ticketEntries.length === 0
  // A fresh player with tickets but no minted items still gets the gallery
  // (mint-first shelf over an empty grid), not the empty state. While a
  // chest arrival or its guided flow is pending, the gallery stays hidden
  // — the player hasn't "arrived" there yet, so it must never flash behind
  // the overlay for a frame.
  const showGallery =
    !showBoot && (entries.length > 0 || ticketEntries.length > 0) && !arrival && !guided

  return (
    <div className="page">
      <PhoneFrame ref={frameRef}>
        <ParticleCanvas ref={particleRef} />
        {showBoot && (
          <div className="boot-screen" aria-live="polite">
            <div className="boot-mark" aria-hidden="true">◈</div>
            <div className="boot-copy">Opening your collection…</div>
          </div>
        )}
        {!showBoot && !showGallery && !arrival && !guided && (
          <EmptyGallery {...(displayName ? { displayName } : {})} />
        )}
        {showGallery && (
          <GalleryScreen
            key={`${collectionGen}-${arrivalGen}`}
            entries={entries}
            tickets={ticketEntries}
            onPickTicket={setPicking}
            onMintAll={mintAll}
            {...(displayName ? { displayName } : {})}
            onOpen={handleOpen}
          />
        )}

        {/* Detail lives INSIDE the frame so it's clipped to the phone in
            desktop preview (and fills the screen when embedded) — a genuine
            representation of the on-device modal, not a window overlay. */}
        {selection && (
          <DetailScreen
            list={selection.list}
            index={selection.index}
            originRect={selection.originRect}
            onClose={handleClose}
            onShow={handleShow}
            onSend={startSend}
            onOpenGame={openGame}
          />
        )}

        {choosingRecipient && (
          <RecipientPicker
            entry={choosingRecipient}
            onPick={(username) => sendTo(choosingRecipient, username)}
            onClose={() => setChoosingRecipient(null)}
          />
        )}

        {sending && (
          <SendOverlay
            requestId={sending.requestId}
            entry={sending.entry}
            recipient={sending.recipient}
            onDone={() => setSending(null)}
          />
        )}

        {picking && (
          <CollectionPicker
            entry={picking}
            favourites={favourites}
            onToggleFavourite={toggleFavourite}
            onChoose={(collectionId) => mintInto([picking], collectionId, guided ? 'advance' : undefined)}
            onClose={() => setPicking(null)}
            // Inline (full-screen flow step) when reached from the guided
            // post-game flow; a modal sheet when opened from the shelf.
            variant={guided ? 'inline' : 'sheet'}
            backLabel="Back"
          />
        )}

        {/* The ceremony deliberately lives OUTSIDE the generation-bump
            cleanup above: the post-mint setCollection bumps the generation
            mid-ceremony (that's the landing beat), and must not dismiss
            the overlay the way it dismisses a stale detail view. */}
        {ceremony && (
          <MintCeremony
            requestIds={ceremony.requestIds}
            entries={ceremony.entries}
            particles={particleRef}
            frameRef={frameRef}
            variantMode={variantMode}
            onDone={() => {
              const after = ceremony.after
              setCeremony(null)
              // In the guided post-game flow: a single mint returns to the
              // flow for the next ticket ('advance'); Mint-all ends it
              // ('exit'). A standalone mint just closes to the collection.
              if (after === 'advance') advanceGuided()
              else if (after === 'exit') exitGuided()
            }}
          />
        )}

        {arrival && ticketEntries.length > 0 && (
          <ChestArrival
            ticketCount={ticketEntries.length}
            particles={particleRef}
            frameRef={frameRef}
            onOpen={() => {
              setArrival(false)
              // Opening the chest starts the guided mint-or-skip flow over
              // the mintable tickets; with none mintable (all finalizing),
              // fall through to the collection with a fresh entrance.
              const queue = ticketEntries.filter((t) => t.state === 'mintable' && !isTicketExpired(t))
              if (queue.length > 0) setGuided({ queue, index: 0 })
              else setArrivalGen((g) => g + 1)
            }}
          />
        )}

        {guided && guided.queue[guided.index] && !picking && !ceremony && (
          <PostGameFlow
            entry={guided.queue[guided.index]!}
            index={guided.index}
            total={guided.queue.length}
            onMint={setPicking}
            onSkip={advanceGuided}
            onExit={exitGuided}
            onMintAll={() => mintAll(guided.queue)}
          />
        )}

        {showIntro && (
          <IntroOverlay onDone={() => { markIntroSeen(); setShowIntro(false) }} />
        )}
      </PhoneFrame>

      <ThemeSwitcher />

      {isDevMode && (
        <DevPanel
          onScenario={loadDevScenario}
          onChest={() => setArrival(true)}
          onIntro={() => setShowIntro(true)}
          onDemoMint={demoMint}
          alwaysDifferent={variantMode === 'random'}
          onToggleAlwaysDifferent={() => setVariantMode((m) => (m === 'random' ? 'signature' : 'random'))}
          {...(readAxisParams() ? { initial: readAxisParams()! } : {})}
        />
      )}
    </div>
  )
}
