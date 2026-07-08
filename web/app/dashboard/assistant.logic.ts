// Arturita J1 (Jarvis tab) — PURE panel logic (no DOM / React / network).
//
// The Assistant tab (AssistantPanel.tsx) is the impure shell: Web Speech
// capture, POST /arturita/converse, TTS playback, and the reactive orb. Every
// DECISION + shape here is a pure function so it's unit-tested with `node --test`
// + type-stripping (see web/package.json `test`), no test-runner dep. The
// voice-capture gate (push-to-talk vs wake-word) is reused from
// ./cockpit/voicePanel.logic (one source of truth for both panels).

// ─── Reactive-orb state machine ──────────────────────────────────────────────
// The signature "living UI": the orb reflects the voice pipeline's state. Each
// state is colorblind-safe — it carries an ICON + LABEL + distinct MOTION, never
// color alone (DESIGN_SYSTEM v2). Colors stay in the purple/blue family (no
// green-vs-red differentiation): idle=muted, listening=accent, thinking=info,
// speaking=accent-2.

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface OrbVisual {
  state: VoiceState
  label: string
  icon: string
  /** CSS variable string for the orb's dominant hue (theme-aware). */
  colorVar: string
  /** animation the shell applies; also the a11y/reduced-motion switch key. */
  motion: 'breathe' | 'pulse' | 'spin' | 'wave'
  /** relative intensity 0..1 — drives ring opacity/scale in the shell. */
  intensity: number
}

const ORB: Record<VoiceState, OrbVisual> = {
  idle:      { state: 'idle',      label: 'Idle',      icon: '○', colorVar: 'var(--muted)',    motion: 'breathe', intensity: 0.25 },
  listening: { state: 'listening', label: 'Listening', icon: '●', colorVar: 'var(--accent)',   motion: 'pulse',   intensity: 1.0 },
  thinking:  { state: 'thinking',  label: 'Thinking',  icon: '◐', colorVar: 'var(--info)',     motion: 'spin',    intensity: 0.7 },
  speaking:  { state: 'speaking',  label: 'Speaking',  icon: '◉', colorVar: 'var(--accent-2)', motion: 'wave',    intensity: 0.85 },
}

/** The orb descriptor for a voice state (colorblind-safe icon+label+motion). */
export function orbVisual(state: VoiceState): OrbVisual {
  return ORB[state] ?? ORB.idle
}

/**
 * Resolve the current voice state from the shell's flags. Precedence:
 * speaking > thinking (busy) > listening > idle. A single source of truth so the
 * orb never shows two states at once.
 */
export function resolveVoiceState(flags: { speaking?: boolean; thinking?: boolean; listening?: boolean }): VoiceState {
  if (flags.speaking) return 'speaking'
  if (flags.thinking) return 'thinking'
  if (flags.listening) return 'listening'
  return 'idle'
}

// ─── Conversation model ──────────────────────────────────────────────────────

export type Role = 'user' | 'arturita'
export type ConverseMode = 'answer' | 'delegate'

export interface Routing {
  trigger: string
  reason: string
  destructive?: boolean
  workMode?: 'ask' | 'execute'
  approvalType?: string | null
  isFollowUp?: boolean
}

export interface Message {
  id: string
  role: Role
  text: string
  /** true while the reply is still being revealed (typewriter streaming). */
  streaming?: boolean
  mode?: ConverseMode
  routing?: Routing | null
  taskId?: string | null
  degraded?: boolean
  /** provenance — e.g. "local · llama3.2:3b" or "cloud · anthropic". */
  via?: string | null
}

// Shape of the /converse response (subset the panel consumes).
export interface ConverseResponse {
  mode?: ConverseMode
  routing?: Routing | null
  taskId?: string | null
  degraded?: boolean
  reply?: { text?: string; provider?: string; model?: string } | null
  error?: string
  /** J-prod: answer deferred to the client for local streaming (browser→Ollama). */
  deferred?: boolean
  prompt?: { system?: string; messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> } | null
}

/** Build the request body for POST /arturita/converse from the running thread. */
export function toConverseRequest(input: {
  message: string
  explicitDelegate?: boolean
  existingThreadId?: string | null
  history: Message[]
  historyLimit?: number
}): { message: string; explicitDelegate: boolean; existingThreadId: string | null; history: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const limit = input.historyLimit ?? 10
  const history = input.history
    .filter(m => m.text.trim().length > 0)
    .slice(-limit)
    .map(m => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.text }))
  return {
    message: input.message.trim(),
    explicitDelegate: !!input.explicitDelegate,
    existingThreadId: input.existingThreadId ?? null,
    history,
  }
}

/** Normalize a /converse response into an Arturita message (never throws). */
export function toArturitaMessage(input: { id: string; resp: ConverseResponse }): Message {
  const { id, resp } = input
  const text = (resp.reply?.text ?? '').trim() || "I didn't get a reply just now."
  const mode = resp.mode ?? 'answer'
  const prov = resp.reply?.provider
  const model = resp.reply?.model
  const via = prov && prov !== 'arturita' && prov !== 'text_only'
    ? `cloud · ${prov}${model ? ` (${model})` : ''}`
    : null
  return {
    id, role: 'arturita', text,
    mode,
    routing: resp.routing ?? null,
    taskId: resp.taskId ?? null,
    degraded: !!resp.degraded,
    via,
    streaming: true,
  }
}

// ─── Streaming reveal (typewriter) ───────────────────────────────────────────
// v1 streams the reply client-side: the backend returns the full answer from the
// F1 fallback chain, and the panel reveals it progressively so it *reads* live.
// (True server token-streaming/SSE is the J-epic fast-follow — see PRD-jarvis-tab.)

/** Next revealed length after one tick. Clamps to [0, total]. */
export function revealNext(shown: number, total: number, step: number): number {
  if (!(step > 0)) return Math.min(Math.max(shown, 0), total)
  return Math.min(total, Math.max(shown, 0) + step)
}

/** True once the whole text is revealed. */
export function isRevealComplete(shown: number, total: number): boolean {
  return shown >= total
}

/**
 * A reveal step scaled to the text length so short replies don't feel slow and
 * long ones don't take forever — target ~a couple seconds regardless of length.
 */
export function revealStepFor(total: number, ticks = 40): number {
  return Math.max(2, Math.ceil(total / Math.max(1, ticks)))
}

// ─── Routing badge (colorblind-safe: icon + label, never color-only) ─────────

export interface RoutingBadge { icon: string; label: string; tone: 'answer' | 'delegate' | 'approval' }

/** Badge describing how a turn routed, for the message header. */
export function routingBadge(msg: Pick<Message, 'mode' | 'routing'>): RoutingBadge {
  if (msg.mode === 'delegate') {
    if (msg.routing?.destructive) return { icon: '⛔', label: 'Delegated · needs approval', tone: 'approval' }
    return { icon: '▸', label: 'Delegated to the office', tone: 'delegate' }
  }
  return { icon: '💬', label: 'Answered directly', tone: 'answer' }
}
