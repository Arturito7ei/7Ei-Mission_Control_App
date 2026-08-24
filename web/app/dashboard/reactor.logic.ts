// Arturita J7 — Command Center reactor: PURE state→visual mapping (no DOM / React
// / network). The reactor (Reactor.tsx) is the impure shell; every DECISION about
// how a voice state should LOOK/READ lives here so it's unit-tested with
// `node --test` + type-stripping (see web/package.json `test`), no runner dep.
//
// Colorblind-safe by construction (DESIGN_SYSTEM v2, same rule as the J1 orb):
// each state carries a distinct ICON + LABEL + MOTION — never colour alone. The
// brushed-silver metal is state-INDEPENDENT; only the supplementary core hue
// tints, and it stays in the blue/purple family (no green-vs-red signalling).
import type { VoiceState } from './assistant.logic'

export interface ReactorVisual {
  state: VoiceState
  /** Short uppercase state word for the caption (e.g. "LISTENING"). */
  label: string
  /** The full status line under the reactor, mirroring the reference HUD. */
  caption: string
  /** Colorblind-safe glyph paired with the label (never colour-only). */
  icon: string
  /** CSS motion key the shell applies (data-motion) AND the reduced-motion switch. */
  motion: 'breathe' | 'listen' | 'think' | 'speak'
  /** Supplementary core hue — a CSS var, theme-aware, blue/purple family only. */
  accentVar: string
  /** Relative intensity 0..1 — drives core glow/scale + ripple opacity in the shell. */
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

// ─── Provenance chip (which model produced/serves the reply) ──────────────────
// Mirrors the reference's "via 🔒 local · llama3.2:3b" line. Colorblind-safe:
// icon + label + tone, never colour alone.

export interface ProvenanceChip { icon: string; label: string; tone: 'local' | 'hosted' | 'cloud' }

/** Where the language model is running right now, for the reactor caption chip. */
export function provenanceChip(input: {
  local?: { model: string } | null
  /** S3-B — hosted backend reached Fly/co-located Ollama (no browser-local model). */
  hosted?: { model: string } | null
}): ProvenanceChip {
  const localModel = input.local?.model?.trim()
  if (localModel) return { icon: '🔒', label: `local · ${localModel}`, tone: 'local' }
  const hostedModel = input.hosted?.model?.trim()
  if (hostedModel) return { icon: '🖥', label: `hosted · ${hostedModel}`, tone: 'hosted' }
  return { icon: '☁', label: 'cloud fallback', tone: 'cloud' }
}

// ─── Status chips row (small capability chips beneath the caption) ────────────
// The reference shows a chip row (ROUTE · WEATHER · SYSTEMS); ours reflects the
// REAL pipeline so the row is honest, not decorative. Every chip is icon+label.

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
