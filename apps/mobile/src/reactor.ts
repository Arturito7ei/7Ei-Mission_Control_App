// MOB-7a — the Command Center reactor's PURE state→visual mapping, ported from
// `web/app/dashboard/reactor.logic.ts`.
//
// WHY A PORT AND NOT AN IMPORT: Metro cannot resolve out of `apps/mobile/` into
// `web/` (the parity rule in the root CLAUDE.md). So the decisions are hand-copied
// — and `reactor.test.ts` imports the WEB module and asserts the two agree, field
// for field, for every voice state. Copy without a tripwire is silent drift; this
// is the copy WITH one.
//
// The split is the web's, unchanged: this module decides how a state should
// LOOK/READ, and `screens/Reactor.tsx` is the impure react-native-svg shell that
// draws it. Nothing here imports react, react-native, or the network.
//
// Colorblind-safe by construction (the web's rule, held verbatim): each state
// carries a distinct ICON + LABEL + MOTION — never colour alone. The brushed
// silver is state-INDEPENDENT; only the supplementary core hue tints, and it
// stays in the blue/purple family (no green-vs-red signalling).

/** The four voice states — mirrors `web/app/dashboard/assistant.logic.ts`. */
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

/** Mirror of the web's `resolveVoiceState` — same precedence, same order. */
export function resolveVoiceState(flags: {
  speaking?: boolean
  thinking?: boolean
  listening?: boolean
}): VoiceState {
  if (flags.speaking) return 'speaking'
  if (flags.thinking) return 'thinking'
  if (flags.listening) return 'listening'
  return 'idle'
}

export interface ReactorVisual {
  state: VoiceState
  /** Short uppercase state word for the caption (e.g. "LISTENING"). */
  label: string
  /** The full status line under the reactor, mirroring the reference HUD. */
  caption: string
  /** Colorblind-safe glyph paired with the label (never colour-only). */
  icon: string
  /** Motion key the shell applies — and the reduced-motion switch. */
  motion: 'breathe' | 'listen' | 'think' | 'speak'
  /**
   * Supplementary core hue. Deliberately still the WEB'S CSS-var STRING rather
   * than a hex: it is the join key. The shell resolves it through
   * REACTOR_ACCENT below, and `reactor.test.ts` can deep-equal this whole object
   * against the web's — which it could not if the port pre-resolved the colour.
   */
  accentVar: string
  /** Relative intensity 0..1 — drives core glow/scale + ripple opacity. */
  intensity: number
  /** Base ring-rotation period in seconds; LOWER = faster (thinking spins fastest). */
  spinSec: number
}

/** The steady headline above the state line — the reference's "SYSTEM COGNITION". */
export const REACTOR_HEADLINE = 'SYSTEM COGNITION'

const REACTOR: Record<VoiceState, ReactorVisual> = {
  // idle = the reference "deep breath cycle" (~0.1 Hz slow pulse), calmest ring drift.
  idle:      { state: 'idle',      label: 'STANDBY',   caption: 'STANDBY · DEEP BREATH CYCLE', icon: '○', motion: 'breathe', accentVar: 'var(--muted)',    intensity: 0.30, spinSec: 48 },
  listening: { state: 'listening', label: 'LISTENING', caption: 'ACTIVE · LISTENING…',          icon: '●', motion: 'listen',  accentVar: 'var(--accent)',   intensity: 1.00, spinSec: 34 },
  thinking:  { state: 'thinking',  label: 'THINKING',  caption: 'ACTIVE · THINKING…',           icon: '◐', motion: 'think',   accentVar: 'var(--info)',     intensity: 0.72, spinSec: 16 },
  speaking:  { state: 'speaking',  label: 'SPEAKING',  caption: 'ACTIVE · RESPONDING…',         icon: '◉', motion: 'speak',   accentVar: 'var(--accent-2)', intensity: 0.88, spinSec: 26 },
}

/** The reactor descriptor for a voice state (colorblind-safe icon+label+motion). */
export function reactorVisual(state: VoiceState): ReactorVisual {
  return REACTOR[state] ?? REACTOR.idle
}

// ─── The metal ────────────────────────────────────────────────────────────────
// The phone renders the web's DARK reactor, so these are `themes.dark` from
// web/app/dashboard/tokens.ts, VERBATIM — including the CSS `rgba(…,.97)`
// spelling, so `reactor.test.ts` can compare them to the web token map as
// strings. `rnColor()` below is what makes them drawable; see it for why.
//
// The one deliberate divergence is `logoFill` — see REACTOR_LOGO_FILL.
export const REACTOR_METAL = {
  silver1: '#f2f5f9',                    // specular highlight
  silver2: '#c6ccd6',                    // light steel
  silver3: '#8b929e',                    // mid steel
  silver4: '#565c67',                    // shadow steel
  silverEdge: '#31353d',                 // ring edge / groove
  core1: 'rgba(232,242,255,.97)',        // core centre (icy white-blue)
  core2: 'rgba(130,178,255,.62)',        // core mid
  core3: 'rgba(86,132,240,.24)',         // core falloff
  glow: 'rgba(130,178,255,.34)',         // outer bloom behind the assembly
} as const

/**
 * The honeycomb mark's fill: BLACK — the web's `themes.light['--reactor-logo-fill']`.
 *
 * This is the ONE place the phone takes the light token onto its dark surface, and
 * it is deliberate rather than an oversight. The mark sits ON the core, and the
 * core is the same icy white-blue in BOTH web themes (`--reactor-core-1` is
 * near-white in dark too). The web's dark token paints the mark
 * `rgba(232,242,255,.97)` — the SAME value as `--reactor-core-1` — which is
 * exactly the wash-out the light theme's own token comment describes fixing by
 * going black. On a phone, held at arm's length, that legibility is the whole
 * point of the logo. So: black mark on the light core, for the reason the web's
 * light theme already documents.
 *
 * Pinned to the web's light token by `reactor.test.ts` — not a stray hex.
 */
export const REACTOR_LOGO_FILL = '#000000'

/**
 * The state accent, keyed by the web CSS var `ReactorVisual.accentVar` names.
 * Values are `themes.dark` from the web's token map, verbatim — blue/purple
 * family only, as the web's colorblind rule requires.
 */
export const REACTOR_ACCENT: Record<string, string> = {
  'var(--muted)': '#7e7e7e',
  'var(--accent)': '#893BFF',
  'var(--info)': '#7b6dff',
  'var(--accent-2)': '#700077',
}

/** Resolve a `ReactorVisual.accentVar` to a drawable colour (muted if unknown). */
export function reactorAccent(accentVar: string): string {
  return rnColor(REACTOR_ACCENT[accentVar] ?? REACTOR_ACCENT['var(--muted)'])
}

/**
 * Normalise a CSS colour string for react-native.
 *
 * The web tokens spell fractional alpha CSS-style (`rgba(130,178,255,.34)`).
 * RN's colour parser wants a leading zero (`0.34`) and silently yields an
 * INVALID colour otherwise — which surfaces as an invisible ring rather than an
 * error. Rather than fork the values (and lose the string-equality tripwire
 * against the web token map), keep them verbatim and normalise here.
 */
export function rnColor(css: string): string {
  return css.replace(/([(,]\s*)\.(\d)/g, '$10.$2')
}

// ─── Motion ───────────────────────────────────────────────────────────────────
// The web drives the reactor's motion from CSS (globals.css `.mc-reactor…`), which
// react-native has no way to consume — so the NUMBERS are ported here, and
// `reactor.test.ts` reads globals.css and asserts each one still matches. That
// keeps "the phone's reactor spins like the desk's" a checked claim rather than a
// hope, without pretending RN can share a stylesheet.

/**
 * Each ring's period multiplier — CSS `--rk-mult`, applied to the state's
 * `--rk-spin` base. Counter-rotating: outer CW, mid band + gyro CCW, accent CW.
 * The accent ring is the fastest (0.55×), which is why "thinking" reads as a spin-up.
 */
export const RING_MULT = {
  /** Outer segmented band — big dashes with gaps (CW). */
  outer: 1,
  /** Mid full brushed band, very slow (CCW). */
  midFull: 2.4,
  /** Mid gyroscope ring, segmented (CCW). */
  gyro: 1.35,
  /** Inner accent ring — thin, state-tinted, fastest (CW). */
  accent: 0.55,
} as const

/** A ring's rotation period in ms: the state's base spin scaled by the ring's mult. */
export function ringDurationMs(spinSec: number, mult: number): number {
  return Math.round(spinSec * mult * 1000)
}

export type CoreMotion = { kind: 'breathe' | 'pulse'; durationMs: number }

/**
 * How the core moves for a motion key — CSS `.mc-reactor[data-motion=…]
 * .mc-reactor-core`. Idle is the reference's "deep breath cycle" (10s ≈ 0.1 Hz);
 * speaking swaps the gentle breathe for a clipped pulse.
 */
export function coreMotion(motion: ReactorVisual['motion']): CoreMotion {
  switch (motion) {
    case 'listen': return { kind: 'breathe', durationMs: 3200 }
    case 'think': return { kind: 'breathe', durationMs: 2100 }
    case 'speak': return { kind: 'pulse', durationMs: 850 }
    default: return { kind: 'breathe', durationMs: 10000 }
  }
}

/** Ripple period + the second ring's offset — CSS `mcReactorRipple` / `-ripple-2`. */
export const RIPPLE_MS = 2400
export const RIPPLE_DELAY_MS = 1200

/** Ripples read as audio energy, so they run only while audio is moving. */
export function ripplesVisible(motion: ReactorVisual['motion']): boolean {
  return motion === 'listen' || motion === 'speak'
}

/** A ripple's starting opacity — CSS `calc(.5 * var(--rk-intensity))`. */
export function rippleOpacity(intensity: number): number {
  return 0.5 * intensity
}

// ─── Provenance chip (which model produced/serves the reply) ──────────────────
// Ported from the web's reactor.logic — the reference's "via 🔒 local · llama3.2:3b"
// line. Colorblind-safe: icon + label + tone, never colour alone.

export interface ProvenanceChip { icon: string; label: string; tone: 'local' | 'cloud' }

/** Where the language model is running right now, for the reactor caption chip. */
export function provenanceChip(input: { local?: { model: string } | null }): ProvenanceChip {
  const model = input.local?.model?.trim()
  return model
    ? { icon: '🔒', label: `local · ${model}`, tone: 'local' }
    : { icon: '☁', label: 'cloud fallback', tone: 'cloud' }
}

// ─── Status chips row (small capability chips beneath the caption) ────────────

export interface StatusChip { key: string; icon: string; label: string }

/** Compose the small status-chip row from the live pipeline flags. */
export function reactorChips(input: {
  provenance: ProvenanceChip
  captureLabel: string          // resolved STT engine label (or "" when unavailable)
  voiceReplies: boolean
}): StatusChip[] {
  const chips: StatusChip[] = [
    { key: 'llm', icon: input.provenance.icon, label: input.provenance.label },
  ]
  chips.push({ key: 'stt', icon: '🎙', label: input.captureLabel.trim() || 'voice off · type' })
  chips.push(input.voiceReplies
    ? { key: 'tts', icon: '🔊', label: 'spoken replies' }
    : { key: 'tts', icon: '🔈', label: 'replies muted' })
  return chips
}
