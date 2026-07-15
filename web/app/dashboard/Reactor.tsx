'use client'
// Arturita J7 — the Command Center "reactor": a big Jarvis-style brushed-silver
// arc-reactor HUD that is the PRINCIPAL view of the tab. Concentric metal rings
// (some full, some segmented with gaps) counter-rotate, a translucent core glows
// and swirls, and the 7Ei honeycomb sits at the centre in glassmorphism.
//
// It's a pure visual shell: the voice state comes in as a prop and every DECISION
// about how that state should look/read is the unit-tested ./reactor.logic. All
// motion is CSS/SVG transforms (GPU-friendly) driven by data-motion + a few CSS
// vars, and is fully disabled under prefers-reduced-motion (globals.css), where
// the state still reads from the caption's icon + label (colorblind-safe).
import { tk, text, space } from './tokens'
import type { VoiceState } from './assistant.logic'
import { reactorVisual, REACTOR_HEADLINE, type StatusChip } from './reactor.logic'

// The 7Ei mark (7-hexagon honeycomb) — same vector as /7ei-mark.svg, inlined so
// it can carry a soft inner glow and share the reactor's currentColor.
const HEX_PATHS = [
  'M43.5 8.74 56.5 8.74 63 20 56.5 31.26 43.5 31.26 37 20Z',
  'M17.52 23.74 30.52 23.74 37.02 35 30.52 46.26 17.52 46.26 11.02 35Z',
  'M69.48 23.74 82.48 23.74 88.98 35 82.48 46.26 69.48 46.26 62.98 35Z',
  'M43.5 38.74 56.5 38.74 63 50 56.5 61.26 43.5 61.26 37 50Z',
  'M17.52 53.74 30.52 53.74 37.02 65 30.52 76.26 17.52 76.26 11.02 65Z',
  'M69.48 53.74 82.48 53.74 88.98 65 82.48 76.26 69.48 76.26 62.98 65Z',
  'M43.5 68.74 56.5 68.74 63 80 56.5 91.26 43.5 91.26 37 80Z',
]

export default function Reactor({
  state, size = 340, chips = [],
}: { state: VoiceState; size?: number; chips?: StatusChip[] }) {
  const v = reactorVisual(state)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.lg }}>
      {/* The assembly. Sized responsively (min of the given size / viewport). */}
      <div
        className="mc-reactor"
        data-motion={v.motion}
        aria-hidden
        style={{
          width: `min(${size}px, 82vw)`,
          ['--rk-spin' as any]: `${v.spinSec}s`,
          ['--rk-accent' as any]: v.accentVar,
          ['--rk-intensity' as any]: v.intensity,
        }}
      >
        {/* Outer bloom behind the metal — depth/layering (its own element so the
            frosted core can sit above it). */}
        <div className="mc-reactor-bloom" />

        {/* Brushed-silver ring assembly (SVG so the metal gradient + gapped arcs
            stay crisp at any size). Counter-rotating groups: outer CW, mid gyro
            CCW, inner accent CW (fastest → most affected by "thinking"). */}
        <svg className="mc-reactor-metal" viewBox="0 0 200 200" role="presentation">
          <defs>
            <linearGradient id="rkSilverA" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--silver-1)" />
              <stop offset="24%" stopColor="var(--silver-3)" />
              <stop offset="50%" stopColor="var(--silver-1)" />
              <stop offset="72%" stopColor="var(--silver-4)" />
              <stop offset="100%" stopColor="var(--silver-2)" />
            </linearGradient>
            <linearGradient id="rkSilverB" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--silver-2)" />
              <stop offset="30%" stopColor="var(--silver-1)" />
              <stop offset="58%" stopColor="var(--silver-4)" />
              <stop offset="100%" stopColor="var(--silver-2)" />
            </linearGradient>
            <radialGradient id="rkSheen" cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor="var(--silver-1)" stopOpacity="0.55" />
              <stop offset="60%" stopColor="var(--silver-3)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Outer fixed rail (thin, full) + a soft sheen wash for the machined look. */}
          <circle cx="100" cy="100" r="96" fill="none" stroke="var(--silver-edge)" strokeWidth="1" opacity="0.6" />
          <circle cx="100" cy="100" r="93" fill="none" stroke="url(#rkSilverA)" strokeWidth="3.5" />

          {/* Outer segmented ring — thick brushed band, big dashes with gaps (CW). */}
          <g className="mc-rr mc-rr-cw" style={{ ['--rk-mult' as any]: 1 }}>
            <circle cx="100" cy="100" r="83" fill="none" stroke="url(#rkSilverB)" strokeWidth="9"
              strokeDasharray="118 40" strokeLinecap="round" />
            <circle cx="100" cy="100" r="83" fill="none" stroke="var(--silver-edge)" strokeWidth="9"
              strokeDasharray="2 74" strokeDashoffset="20" opacity="0.5" />
          </g>

          {/* Mid full band (very slow CCW) — the solid brushed ring. */}
          <g className="mc-rr mc-rr-ccw" style={{ ['--rk-mult' as any]: 2.4 }}>
            <circle cx="100" cy="100" r="70" fill="none" stroke="url(#rkSilverA)" strokeWidth="7" />
            <circle cx="100" cy="100" r="66.5" fill="none" stroke="var(--silver-edge)" strokeWidth="1" opacity="0.7" />
          </g>

          {/* Mid gyroscope ring — segmented with gaps + HUD ticks (CCW, medium). */}
          <g className="mc-rr mc-rr-ccw" style={{ ['--rk-mult' as any]: 1.35 }}>
            <circle cx="100" cy="100" r="58" fill="none" stroke="url(#rkSilverB)" strokeWidth="4.5"
              strokeDasharray="44 26" strokeLinecap="round" />
          </g>

          {/* Inner accent ring — thin, tinted by the state accent (CW, fastest). */}
          <g className="mc-rr mc-rr-cw" style={{ ['--rk-mult' as any]: 0.55 }}>
            <circle cx="100" cy="100" r="50" fill="none" stroke="var(--rk-accent)" strokeWidth="1.5"
              strokeDasharray="10 16" opacity="0.85" />
          </g>

          {/* Specular sheen overlay (fixed) — a highlight that reads as a light source. */}
          <circle cx="100" cy="100" r="96" fill="url(#rkSheen)" />
        </svg>

        {/* Listening/speaking ripples — expanding rings that read as audio energy. */}
        <span className="mc-reactor-ripple" />
        <span className="mc-reactor-ripple mc-reactor-ripple-2" />

        {/* Translucent glowing core (glassmorphism) with a swirling energy layer,
            and the honeycomb mark floated at the centre, frosted + inner-glowing. */}
        <div className="mc-reactor-core">
          <div className="mc-reactor-swirl" />
          <div className="mc-reactor-hex">
            <svg viewBox="0 0 100 100" role="img" aria-label="7Ei — Arturita">
              {HEX_PATHS.map((d, i) => <path key={i} d={d} fill="currentColor" />)}
            </svg>
          </div>
        </div>
      </div>

      {/* ── Status caption (mirrors the reference HUD) — colorblind-safe ─────── */}
      <div role="status" aria-live="polite" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.sm }}>
        <span style={{ fontSize: text.xs.fontSize, letterSpacing: 2, color: tk.muted, textTransform: 'uppercase', fontWeight: 700 }}>
          {REACTOR_HEADLINE}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          <span aria-hidden style={{ color: v.accentVar, fontSize: 16, lineHeight: 1 }}>{v.icon}</span>
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase', color: state === 'idle' ? tk.textDim : tk.text }}>
            {v.caption}
          </span>
        </span>
        {chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm, marginTop: space.xxs }}>
            {chips.map(c => (
              <span key={c.key} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: text.xs.fontSize, fontWeight: 600, color: tk.textDim,
                background: 'var(--glass)', border: '1px solid var(--glass-line)',
                borderRadius: tk.r.pill, padding: '3px 10px', whiteSpace: 'nowrap',
              }}>
                <span aria-hidden>{c.icon}</span>{c.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
