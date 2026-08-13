import { useId } from 'react'

/** An unclaimed credit drawn as a cute wrapped parcel: pastel paper with a
 *  patterned motif, a ribbon + bow, and twinkling sparkles. The wrapping is
 *  picked deterministically from `seed` (the credit's hash), so every
 *  unclaimed credit keeps its own wrapping across renders — and different
 *  credits get different wrappings. The "wants to be unwrapped" feel (a
 *  periodic wiggle, the lid peeking open) is CSS-driven; each instance
 *  offsets its animation phase from the seed so a shelf of parcels fidgets
 *  out of sync. See the `.gift-*` rules in styles.css. */

type Motif = 'dots' | 'stripes' | 'hearts' | 'stars' | 'zigzag' | 'confetti'

interface Wrapping {
  paper: string
  /** Slightly deeper paper tone for the lid, so the parcel reads 3-D. */
  paperDeep: string
  ribbon: string
  ribbonDeep: string
  motif: Motif
}

const WRAPPINGS: Wrapping[] = [
  { paper: '#ffd9e3', paperDeep: '#ffc3d3', ribbon: '#ff87a5', ribbonDeep: '#e8688c', motif: 'dots' },
  { paper: '#c9f0df', paperDeep: '#b0e6cf', ribbon: '#ff9e6d', ribbonDeep: '#f2814b', motif: 'stripes' },
  { paper: '#fff0b8', paperDeep: '#ffe692', ribbon: '#ff9db6', ribbonDeep: '#f27e9d', motif: 'hearts' },
  { paper: '#e6dbff', paperDeep: '#d6c6ff', ribbon: '#9f86ff', ribbonDeep: '#8267f0', motif: 'stars' },
  { paper: '#cde9ff', paperDeep: '#b4dcff', ribbon: '#ffc24b', ribbonDeep: '#f0ac2e', motif: 'zigzag' },
  { paper: '#ffe3cd', paperDeep: '#ffd3b1', ribbon: '#6fcf97', ribbonDeep: '#53b67e', motif: 'confetti' }
]

/** Cheap deterministic string hash — wrapping pick + animation phase. */
function seedNumber(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h
}

/** 4-point sparkle path centred on (cx, cy) with radius s. */
function sparkPath(cx: number, cy: number, s: number): string {
  return (
    `M${cx} ${cy - s} L${cx + s * 0.3} ${cy - s * 0.3} L${cx + s} ${cy} ` +
    `L${cx + s * 0.3} ${cy + s * 0.3} L${cx} ${cy + s} L${cx - s * 0.3} ${cy + s * 0.3} ` +
    `L${cx - s} ${cy} L${cx - s * 0.3} ${cy - s * 0.3} Z`
  )
}

/** Repeating wrapping-paper motif, tiled in user space over paper rects. */
function MotifPattern({ id, motif }: { id: string; motif: Motif }) {
  switch (motif) {
    case 'dots':
      return (
        <pattern id={id} width="11" height="11" patternUnits="userSpaceOnUse">
          <circle cx="5.5" cy="5.5" r="2" fill="#fff" opacity="0.8" />
        </pattern>
      )
    case 'stripes':
      return (
        <pattern id={id} width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="5" height="10" fill="#fff" opacity="0.55" />
        </pattern>
      )
    case 'hearts':
      return (
        <pattern id={id} width="13" height="13" patternUnits="userSpaceOnUse">
          <path
            d="M6.5 9.8 C2.4 7 3.2 3.4 5.4 3.4 c0.9 0 1.1 0.7 1.1 0.7 s0.2 -0.7 1.1 -0.7 c2.2 0 3 3.6 -1.1 6.4 Z"
            fill="#fff" opacity="0.8"
          />
        </pattern>
      )
    case 'stars':
      return (
        <pattern id={id} width="13" height="13" patternUnits="userSpaceOnUse">
          <path d={sparkPath(6.5, 6.5, 3)} fill="#fff" opacity="0.8" />
        </pattern>
      )
    case 'zigzag':
      return (
        <pattern id={id} width="12" height="9" patternUnits="userSpaceOnUse">
          <path
            d="M0 6.5 L3 2.5 L6 6.5 L9 2.5 L12 6.5"
            stroke="#fff" strokeWidth="1.6" fill="none" opacity="0.65"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </pattern>
      )
    case 'confetti':
      return (
        <pattern id={id} width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="4" r="1.5" fill="#fff" opacity="0.9" />
          <circle cx="11" cy="2" r="1.5" fill="#ff8fb0" opacity="0.9" />
          <circle cx="7" cy="10" r="1.5" fill="#7cc8ff" opacity="0.9" />
          <circle cx="14" cy="12" r="1.5" fill="#fff" opacity="0.9" />
        </pattern>
      )
  }
}

interface GiftBundleProps {
  /** Stable id (the credit's hash) — picks the wrapping + animation phase. */
  seed: string
  className?: string
}

export default function GiftBundle({ seed, className }: GiftBundleProps) {
  // useId is unique per instance, so each parcel's <pattern> def never
  // collides with its shelf-mates'. Colons stripped: they're awkward inside
  // url(#…) references.
  const uid = useId().replace(/:/g, '')
  const n = seedNumber(seed)
  const wrap = WRAPPINGS[n % WRAPPINGS.length]!
  const patternId = `gift-motif-${uid}`
  // Hash-derived phase offset (0–2.4s) so parcels fidget out of sync.
  const delay = ((n >>> 3) % 2400) / 1000

  return (
    <div
      className={['gift', className].filter(Boolean).join(' ')}
      style={{ '--gift-delay': `${delay}s` } as React.CSSProperties}
      aria-hidden="true"
    >
      <svg className="gift-svg" viewBox="0 0 100 100">
        <defs>
          <MotifPattern id={patternId} motif={wrap.motif} />
        </defs>
        <g className="gift-rock">
          {/* Box body: paper, then the motif tiled over it. */}
          <rect x="22" y="46" width="56" height="42" rx="7" fill={wrap.paper} />
          <rect x="22" y="46" width="56" height="42" rx="7" fill={`url(#${patternId})`} />
          {/* Vertical ribbon with shaded edges. */}
          <rect x="43.5" y="46" width="13" height="42" fill={wrap.ribbon} />
          <rect x="43.5" y="46" width="1.6" height="42" fill={wrap.ribbonDeep} opacity="0.5" />
          <rect x="54.9" y="46" width="1.6" height="42" fill={wrap.ribbonDeep} opacity="0.5" />
          {/* Lid + bow lift together for the "peek" — see giftLidPeek. */}
          <g className="gift-lid">
            <rect x="16" y="35" width="68" height="15" rx="5.5" fill={wrap.paperDeep} />
            <rect x="16" y="35" width="68" height="15" rx="5.5" fill={`url(#${patternId})`} />
            <rect x="43.5" y="35" width="13" height="15" fill={wrap.ribbon} />
            <path
              d="M50 33 C38 21 24 25 29 34 C32 40 43 38 50 33 Z"
              fill={wrap.ribbon} stroke={wrap.ribbonDeep} strokeWidth="1.6" strokeLinejoin="round"
            />
            <path
              d="M50 33 C62 21 76 25 71 34 C68 40 57 38 50 33 Z"
              fill={wrap.ribbon} stroke={wrap.ribbonDeep} strokeWidth="1.6" strokeLinejoin="round"
            />
            <circle cx="50" cy="33" r="4.6" fill={wrap.ribbonDeep} />
            <circle cx="48.6" cy="31.6" r="1.4" fill="#fff" opacity="0.65" />
          </g>
        </g>
        {/* Gold glints — outside .gift-rock so they don't shake with the box. */}
        <path className="gift-spark" d={sparkPath(15, 24, 4)} fill="#ffcf5c" />
        <path className="gift-spark gift-spark--late" d={sparkPath(87, 42, 3)} fill="#ffcf5c" />
      </svg>
    </div>
  )
}
