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

// ─── Attachments (CC-ATT) ────────────────────────────────────────────────────
// The operator can attach a document to a turn. The file goes to
// POST /arturita/attachments/extract (the backend's officeparser path — the same
// one the knowledge ingest uses); the extracted TEXT comes back and rides the
// next /converse call as `attachment`. Nothing is stored anywhere.
//
// The checks below are a courtesy, not a control: the server re-checks type,
// size and length. Their job is to fail in the composer — instantly, before a
// 10 MB upload — rather than after a round-trip.

// ⚠️ MIRRORS THE SERVER — the web bundle has no import path into `backend/`, so
// these two constants are hand-copied, exactly as `web/lib/adapterProfile.ts`
// mirrors the adapter registry. That is tolerable ONLY because the server is the
// real enforcer: drift here costs a worse message (a file the composer waves
// through, refused a second later by the backend with the same reasoning), never
// a bypass. If you change either, change it there FIRST:
//   backend/src/services/converse-attachments.ts → MAX_ATTACHMENT_BYTES
//   backend/src/services/document-ingest.ts      → SUPPORTED_DOC_EXTS

/** Extensions the backend's parser can read. Mirrors SUPPORTED_DOC_EXTS. */
export const ATTACH_EXTS = [
  'csv', 'docx', 'json', 'log', 'markdown', 'md', 'odp', 'ods', 'odt', 'pdf', 'pptx', 'tsv', 'txt', 'xlsx',
] as const

/** The `accept` attribute for the file picker — filters the OS dialog. */
export const ATTACH_ACCEPT = ATTACH_EXTS.map(e => `.${e}`).join(',')

/** Mirrors MAX_ATTACHMENT_BYTES in backend/src/services/converse-attachments.ts. */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024

export interface AttachedDoc {
  name: string
  size: number
  /** extracted text — absent until the extract call returns. */
  text?: string
  truncated?: boolean
}

export function attachExtension(filename: string): string {
  return (filename.split('.').pop() ?? '').toLowerCase()
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Why this file can't be attached, or null if it can. Phrased for the operator:
 * it names the limit or the readable types, so the next attempt succeeds.
 */
export function rejectAttachment(file: { name: string; size: number }): string | null {
  const ext = attachExtension(file.name)
  if (!(ATTACH_EXTS as readonly string[]).includes(ext)) {
    return `I can't read .${ext} files. Try one of: ${ATTACH_EXTS.join(', ')}.`
  }
  if (file.size <= 0) return `“${file.name}” is empty.`
  if (file.size > ATTACH_MAX_BYTES) {
    return `“${file.name}” is ${formatFileSize(file.size)} — the limit is ${formatFileSize(ATTACH_MAX_BYTES)}.`
  }
  return null
}

/** The chip label under the composer: name + size, plus a truncation hint. */
export function attachmentChipLabel(doc: AttachedDoc): string {
  const base = `${doc.name} · ${formatFileSize(doc.size)}`
  return doc.truncated ? `${base} · truncated` : base
}

// ─── Photos (MOB-7b) ─────────────────────────────────────────────────────────
// A photo is NOT a document and does not share the pipeline above. A document is
// turned into text by /attachments/extract and fenced into the turn; a photo has
// no text to extract — the pixels are the payload — so it rides the /converse
// call itself as base64 and reaches the model as a real image block, which its
// vision reads. Hence a separate field, separate state and separate limits.
//
// ⚠️ MIRRORS THE SERVER, exactly as the document constants above do, and for the
// same reason (no import path from the web bundle into `backend/`). The server
// re-checks both, so drift here costs a worse message, never a bypass. Change it
// there FIRST:
//   backend/src/services/converse-images.ts → MAX_IMAGE_BYTES · SUPPORTED_IMAGE_EXTS

/** Extensions every vision provider accepts. Mirrors SUPPORTED_IMAGE_EXTS. */
export const IMAGE_EXTS = ['gif', 'jpeg', 'jpg', 'png', 'webp'] as const

/** The `accept` attribute for the photo picker — filters the OS dialog. */
export const IMAGE_ACCEPT = IMAGE_EXTS.map(e => `.${e}`).join(',')

/**
 * Mirrors MAX_IMAGE_BYTES in backend/src/services/converse-images.ts. Not a
 * round number on purpose: base64 inflates by 4/3 and Anthropic caps an encoded
 * image at 5 MB, so the raw ceiling is 3/4 of that. Keep the expression rather
 * than the literal — it is the reason the number is what it is.
 */
export const IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024)

export interface AttachedImage {
  name: string
  size: number
  /** the image's media type, e.g. `image/jpeg`. */
  mediaType: string
  /** RAW base64 — no `data:` prefix. Absent until the file has been read. */
  data?: string
}

/**
 * Why this photo can't be attached, or null if it can. Phrased for the operator,
 * naming the limit or the formats — the same contract as rejectAttachment.
 */
export function rejectImage(file: { name: string; size: number }): string | null {
  const ext = attachExtension(file.name)
  if (!(IMAGE_EXTS as readonly string[]).includes(ext)) {
    // HEIC gets its own sentence: it is what an iPhone photo IS, so an operator
    // hitting this needs "convert it", not "that's not an image".
    const heic = ext === 'heic' || ext === 'heif'
      ? ` iPhone photos are HEIC by default — re-save it as JPEG first.`
      : ''
    return `I can't see .${ext} images. Try one of: ${IMAGE_EXTS.join(', ')}.${heic}`
  }
  if (file.size <= 0) return `“${file.name}” is empty.`
  if (file.size > IMAGE_MAX_BYTES) {
    return `“${file.name}” is ${formatFileSize(file.size)} — the limit is ${formatFileSize(IMAGE_MAX_BYTES)}. A smaller or more compressed copy will work.`
  }
  return null
}

/** The photo chip's label under the composer: name + size. */
export function imageChipLabel(img: AttachedImage): string {
  return `${img.name} · ${formatFileSize(img.size)}`
}

/** The media type for a picked image, from the browser's own type when it gave
 *  one, else inferred from the extension (some browsers leave `type` blank). */
export function imageMediaType(file: { name: string; type?: string }): string {
  const t = (file.type ?? '').trim().toLowerCase()
  if (t.startsWith('image/')) return t === 'image/jpg' ? 'image/jpeg' : t
  const ext = attachExtension(file.name)
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

/** A send is allowed when there is text, a fully-extracted document, or a
 *  fully-read photo. Each alone is a legitimate turn: "read this", "what's
 *  this?". A half-loaded attachment of either kind is not. */
export function canSendTurn(input: {
  typed: string
  attachment?: AttachedDoc | null
  image?: AttachedImage | null
  busy?: boolean
}): boolean {
  if (input.busy) return false
  if (input.typed.trim().length > 0) return true
  if (input.attachment?.text) return true
  return !!input.image?.data
}

// ─── Conversation model ──────────────────────────────────────────────────────

export type Role = 'user' | 'arturita'
/** GC-1 adds `agent`: a picked agent ran this turn through the executor. */
export type ConverseMode = 'answer' | 'delegate' | 'agent'

export interface Routing {
  trigger: string
  reason: string
  destructive?: boolean
  workMode?: 'ask' | 'execute'
  approvalType?: string | null
  isFollowUp?: boolean
}

/** GC-1 — who a turn is addressed to / who wrote it. Mirrors the `agent` block the
 *  /converse route returns on every response shape. */
export interface AgentIdentity {
  id: string
  name: string
  avatarEmoji?: string | null
  avatarUrl?: string | null
  role?: string | null
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
  /** GC-1 — WHO replied. Drives the name + avatar in the transcript, so a thread that
   *  switched agents mid-way still attributes each bubble correctly. Absent on old
   *  messages and on user turns. */
  agent?: AgentIdentity | null
  /** GC-1 — set when this reply came from a picked agent (as opposed to Arturita).
   *  It is what marks the turn as UNTRUSTED when it is sent back as history: the
   *  server fences any turn carrying it. */
  fromAgent?: string | null
  /** GC-1 — "an action is waiting for your approval". Rendered inline so a gated
   *  connector call does not read as the agent having gone silent. */
  pendingApprovalNote?: string | null
  /** GC-1 audit (LOW-1) — on a DELEGATE turn, who the work was handed to. Distinct
   *  from `agent`, which is who WROTE the reply (Arturita, on that branch). Rendered
   *  as an "→ assigned to X" chip, never as the speaker. */
  assignedTo?: { id: string; name: string } | null
}

// Shape of the /converse response (subset the panel consumes).
export interface ConverseResponse {
  mode?: ConverseMode
  routing?: Routing | null
  taskId?: string | null
  degraded?: boolean
  reply?: { text?: string; provider?: string; model?: string } | null
  error?: string
  /** MOB-7b: `no_vision_model` — a photo was sent but no configured model can
   *  see. Distinguishes "a model answered but is blind" from "no model at all",
   *  which are degraded in the same way but need different things said. */
  code?: string
  /** J-prod: answer deferred to the client for local streaming (browser→Ollama). */
  deferred?: boolean
  prompt?: { system?: string; messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> } | null
  /** GC-1 — who answered (or, on a delegate turn, who the ack is from). */
  agent?: AgentIdentity | null
  /** GC-1 — on a delegate turn, who the work was assigned to. */
  assignedTo?: { id: string; name: string } | null
  /** GC-1 — connector actions this turn parked at the CONN-7 approval gate. */
  pendingApprovals?: number
  pendingApprovalNote?: string | null
}

/** GC-1 — the id the picker uses for "Arturita" (the default recipient).
 *
 *  Deliberately a SENTINEL rather than her real agent id: the panel must be able to
 *  render a correct default before the roster has loaded, and it must never send a
 *  guessed id. Sending `null` is what the server reads as "the default", so the
 *  sentinel never leaves the client. */
export const ARTURITA_CHOICE = '__arturita__'

/** Map the picker's selection to the wire value. The sentinel and "nothing picked"
 *  both become `null` — i.e. exactly the pre-GC-1 request body. */
export function toWireAgentId(choice: string | null | undefined): string | null {
  if (!choice || choice === ARTURITA_CHOICE) return null
  return choice
}

/** Build the request body for POST /arturita/converse from the running thread. */
export function toConverseRequest(input: {
  message: string
  explicitDelegate?: boolean
  existingThreadId?: string | null
  history: Message[]
  historyLimit?: number
  /** CC-ATT: the document attached to THIS turn (already extracted to text). */
  attachment?: AttachedDoc | null
  /** MOB-7b: the photo attached to THIS turn (already read to base64). */
  image?: AttachedImage | null
  /** GC-1 — the picker's selection. `null`/the Arturita sentinel omit the field
   *  entirely, so an operator who never touches the picker sends the exact body
   *  this function built before GC-1 existed. */
  agentId?: string | null
}): {
  message: string
  explicitDelegate: boolean
  existingThreadId: string | null
  history: Array<{ role: 'user' | 'assistant'; content: string; fromAgent?: string }>
  attachment?: { name: string; text: string; truncated: boolean }
  image?: { name: string; mediaType: string; data: string }
  agentId?: string
} {
  const limit = input.historyLimit ?? 10
  const history = input.history
    .filter(m => m.text.trim().length > 0)
    .slice(-limit)
    .map(m => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text,
      // GC-1 CONTAINMENT: mark turns an AGENT wrote. The server fences those as
      // untrusted (they may quote a GitHub issue or an email). Arturita's own replies
      // and operator turns carry no marker and are admitted unchanged.
      ...(m.role !== 'user' && m.fromAgent ? { fromAgent: m.fromAgent } : {}),
    }))
  // Only a document that actually extracted to text is worth sending; an empty
  // one would just cost tokens for an empty block.
  const att = input.attachment?.text?.trim()
    ? { name: input.attachment.name, text: input.attachment.text, truncated: !!input.attachment.truncated }
    : undefined
  // Same rule for the photo: a picked-but-unread image has no bytes to send, and
  // an empty image block would cost a round-trip to be refused.
  const img = input.image?.data?.trim()
    ? { name: input.image.name, mediaType: input.image.mediaType, data: input.image.data }
    : undefined
  const wireAgentId = toWireAgentId(input.agentId)
  return {
    message: input.message.trim(),
    explicitDelegate: !!input.explicitDelegate,
    existingThreadId: input.existingThreadId ?? null,
    history,
    ...(att ? { attachment: att } : {}),
    ...(img ? { image: img } : {}),
    ...(wireAgentId ? { agentId: wireAgentId } : {}),
  }
}

/** GC-2 — hydrate Command Center from persisted server turns. */
export function persistedTurnsToMessages(turns: Array<{
  id: string
  role: 'user' | 'arturita' | 'assistant'
  content: string
  meta?: {
    mode?: ConverseMode
    via?: string | null
    taskId?: string | null
    fromAgent?: string | null
    agent?: AgentIdentity | null
    assignedTo?: { id: string; name: string } | null
    pendingApprovalNote?: string | null
    degraded?: boolean
    routing?: Routing | null
  }
}>): Message[] {
  return turns.map(t => ({
    id: t.id,
    role: t.role === 'user' ? 'user' : 'arturita',
    text: t.content,
    mode: t.meta?.mode,
    routing: t.meta?.routing ?? null,
    taskId: t.meta?.taskId ?? null,
    degraded: t.meta?.degraded,
    via: t.meta?.via ?? null,
    agent: t.meta?.agent ?? null,
    fromAgent: t.meta?.fromAgent ?? null,
    pendingApprovalNote: t.meta?.pendingApprovalNote ?? null,
    assignedTo: t.meta?.assignedTo ?? null,
  }))
}

/** Normalize a /converse response into an Arturita message (never throws). */
export function toArturitaMessage(input: { id: string; resp: ConverseResponse }): Message {
  const { id, resp } = input
  const text = (resp.reply?.text ?? '').trim() || "I didn't get a reply just now."
  const mode = resp.mode ?? 'answer'
  const prov = resp.reply?.provider
  const model = resp.reply?.model
  const via = prov === 'ollama' && model
    ? `hosted · ${model}`
    : prov && prov !== 'arturita' && prov !== 'text_only' && prov !== 'agent_error'
      ? `cloud · ${prov}${model ? ` (${model})` : ''}`
      : null
  // GC-1 — `mode: 'agent'` means a picked agent ran this turn. `fromAgent` is what
  // marks the reply UNTRUSTED when it is sent back as history; it is set ONLY for a
  // real agent, never for Arturita, so her replies keep re-entering as they always did.
  const agent = resp.agent ?? null
  const fromAgent = mode === 'agent' && agent?.name ? agent.name : null
  return {
    id, role: 'arturita', text,
    mode,
    routing: resp.routing ?? null,
    taskId: resp.taskId ?? null,
    degraded: !!resp.degraded,
    via,
    agent,
    fromAgent,
    pendingApprovalNote: resp.pendingApprovalNote ?? null,
    assignedTo: resp.assignedTo ?? null,
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
  // GC-1 — a picked agent RAN this turn (its own memory, tools and connectors). Says
  // so distinctly: "Answered directly" would read as Arturita and hide the fact that
  // an executor run — and possibly a connector call — happened.
  if (msg.mode === 'agent') return { icon: '⚡', label: 'Answered by agent', tone: 'delegate' }
  return { icon: '💬', label: 'Answered directly', tone: 'answer' }
}

// ─── GC-3 — Jira project picker (Command Center context) ─────────────────────

export type JiraProjectOption = { id: string; key: string; name: string; type?: string | null }

/** Pick the saved key when still valid, else Jira default, else first project. */
export function resolveJiraProjectSelection(
  projects: ReadonlyArray<JiraProjectOption>,
  savedKey: string | null | undefined,
  defaultKey: string | null | undefined,
): string {
  const keys = new Set(projects.map(p => p.key))
  if (savedKey && keys.has(savedKey)) return savedKey
  if (defaultKey && keys.has(defaultKey)) return defaultKey
  return projects[0]?.key ?? ''
}

export function jiraProjectLabel(projects: ReadonlyArray<JiraProjectOption>, key: string): string {
  const hit = projects.find(p => p.key === key)
  return hit ? `${hit.key} — ${hit.name}` : (key || 'No project')
}
