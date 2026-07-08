// Arturita — persona, command sessions, single-operator binding & /panic (A1).
//
// The safety spine's foundation. Arturita is a single-operator agent persona
// (the female counterpart to Arturito); every dangerous surface she gains later
// (files, wallet, email, machine exec) authenticates through a short-lived,
// revocable **command session** minted here, and a one-operator **binding** that
// ties remote control (Telegram chat id + Cockpit identity) to exactly one owner.
//
// These are PURE helpers (crypto + arithmetic, no IO, injectable `now`/token so
// they're deterministically testable) — the route layer does the DB work and
// pushes concrete values in. Nothing here reaches the network or the filesystem.
//
// Design invariants encoded below:
//  - Sessions expire on TTL and are individually revocable (fail-closed: an
//    unknown/expired/revoked token is never valid).
//  - Dangerous actions require a *fresh* session (step-up): freshness is measured
//    from the last step-up (or creation), not merely "not expired".
//  - Binding is one operator only; an identity that isn't the bound operator is
//    refused (the route logs the refusal).
//  - `/panic` is never itself gated — it only ever *removes* capability (pause +
//    cancel runs + revoke every session), so making it easy to trigger is safe.

import { randomBytes, createHash, timingSafeEqual } from 'crypto'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Command sessions are short-lived by design (remote blast radius). 30 min. */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

/** A session older than this since its last step-up must re-confirm (step-up)
 *  before a dangerous action. 5 min — long enough for a multi-step flow, short
 *  enough that a walked-away desk / stolen phone can't authorize an hour later. */
export const DEFAULT_STEPUP_FRESHNESS_MS = 5 * 60 * 1000

/** One-time bind codes expire fast — they're read aloud / typed once. 10 min. */
export const DEFAULT_BIND_CODE_TTL_MS = 10 * 60 * 1000

export const SESSION_SOURCES = ['desk', 'telegram'] as const
export type SessionSource = (typeof SESSION_SOURCES)[number]

// ─── Token / code hashing ────────────────────────────────────────────────────

/** Random opaque session token (returned to the caller ONCE; only its hash is
 *  stored). `art_` prefix mirrors the `mca_` agent-token convention. */
export function generateSessionToken(): string {
  return 'art_' + randomBytes(24).toString('hex')
}

/** SHA-256 hex of a token/code — what we persist and compare against. */
export function hashToken(token: string): string {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** Constant-time hex-hash compare — never throws, false on any mismatch. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ─── Session records ─────────────────────────────────────────────────────────

export interface SessionRecord {
  tokenHash: string
  source: SessionSource
  createdAt: Date
  expiresAt: Date
  lastStepupAt: Date | null
  revokedAt: Date | null
}

export interface MintedSession {
  /** The plaintext token — returned to the caller once, never stored. */
  token: string
  record: SessionRecord
}

/** Mint a command session. `token` is injectable for tests; defaults to a fresh
 *  random one. `lastStepupAt` starts at creation so a brand-new session is fresh
 *  enough for one dangerous action (the mint itself is a Clerk-authed act). */
export function mintSession(input: {
  source: SessionSource
  now?: Date
  ttlMs?: number
  token?: string
}): MintedSession {
  const now = input.now ?? new Date()
  const ttl = input.ttlMs ?? DEFAULT_SESSION_TTL_MS
  const token = input.token ?? generateSessionToken()
  return {
    token,
    record: {
      tokenHash: hashToken(token),
      source: input.source,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl),
      lastStepupAt: now,
      revokedAt: null,
    },
  }
}

export function isExpired(record: Pick<SessionRecord, 'expiresAt'>, now: Date = new Date()): boolean {
  return now.getTime() >= record.expiresAt.getTime()
}

export function isRevoked(record: Pick<SessionRecord, 'revokedAt'>): boolean {
  return record.revokedAt != null
}

/** A session is valid iff it exists, is not revoked, and has not expired.
 *  Fail-closed: a null/undefined record (unknown token) is never valid. */
export function isSessionValid(
  record: Pick<SessionRecord, 'expiresAt' | 'revokedAt'> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!record) return false
  return !isRevoked(record) && !isExpired(record, now)
}

/** Whether the session is *fresh* enough for a dangerous action (step-up). A
 *  freshly-stepped-up (or freshly-minted) session is fresh; one that's been idle
 *  past the freshness window must step up again. Invalid sessions are never
 *  fresh. */
export function isFresh(
  record: Pick<SessionRecord, 'expiresAt' | 'revokedAt' | 'lastStepupAt' | 'createdAt'> | null | undefined,
  now: Date = new Date(),
  freshnessMs: number = DEFAULT_STEPUP_FRESHNESS_MS,
): boolean {
  if (!isSessionValid(record ?? null, now)) return false
  const anchor = (record!.lastStepupAt ?? record!.createdAt).getTime()
  return now.getTime() - anchor <= freshnessMs
}

/** Inverse of {@link isFresh}, for a valid session: does a dangerous action need
 *  a step-up first? An invalid session needs re-auth, not merely step-up, so we
 *  return true (caller rejects). */
export function needsStepUp(
  record: Parameters<typeof isFresh>[0],
  now: Date = new Date(),
  freshnessMs: number = DEFAULT_STEPUP_FRESHNESS_MS,
): boolean {
  return !isFresh(record, now, freshnessMs)
}

/** The patch that records a step-up (freshness refresh) on a valid session. */
export function stepUpPatch(now: Date = new Date()): { lastStepupAt: Date } {
  return { lastStepupAt: now }
}

// ─── Binding (single operator) ───────────────────────────────────────────────

export interface BindingRecord {
  operatorUserId: string
  telegramChatId: string | null
  bindCodeHash: string | null
  bindCodeExpiresAt: Date | null
  boundAt: Date | null
  revokedAt: Date | null
}

/** Human-friendly one-time bind code (8 hex chars, uppercased) — read in the
 *  Cockpit, entered in Telegram. Injectable for tests. */
export function generateBindCode(raw?: string): string {
  return (raw ?? randomBytes(4).toString('hex')).toUpperCase()
}

/** Begin a binding: store the code hash + expiry for the owner, unbound until the
 *  code is confirmed from Telegram. */
export function beginBinding(input: {
  operatorUserId: string
  code: string
  now?: Date
  codeTtlMs?: number
}): BindingRecord {
  const now = input.now ?? new Date()
  const ttl = input.codeTtlMs ?? DEFAULT_BIND_CODE_TTL_MS
  return {
    operatorUserId: input.operatorUserId,
    telegramChatId: null,
    bindCodeHash: hashToken(input.code),
    bindCodeExpiresAt: new Date(now.getTime() + ttl),
    boundAt: null,
    revokedAt: null,
  }
}

export interface BindPatch {
  telegramChatId: string
  boundAt: Date
  bindCodeHash: null
  bindCodeExpiresAt: null
}

// Non-discriminated result (matches the repo's `DecisionResult` shape) so it
// narrows cleanly under the project's tsconfig.
export interface BindResult {
  ok: boolean
  error?: string
  patch?: BindPatch
}

/** Confirm a bind code from a Telegram chat. Fail-closed on: no pending code,
 *  expired code, wrong code, already-revoked binding. On success the code is
 *  cleared (single-use) and the chat id is bound. */
export function confirmBinding(
  binding: BindingRecord | null | undefined,
  input: { code: string; telegramChatId: string; now?: Date },
): BindResult {
  const now = input.now ?? new Date()
  if (!binding) return { ok: false, error: 'no binding in progress' }
  if (binding.revokedAt) return { ok: false, error: 'binding revoked' }
  if (!binding.bindCodeHash || !binding.bindCodeExpiresAt) return { ok: false, error: 'no pending bind code' }
  if (now.getTime() >= binding.bindCodeExpiresAt.getTime()) return { ok: false, error: 'bind code expired' }
  if (!hashesEqual(hashToken(input.code), binding.bindCodeHash)) return { ok: false, error: 'invalid bind code' }
  if (!String(input.telegramChatId).trim()) return { ok: false, error: 'telegram chat id required' }
  return {
    ok: true,
    patch: { telegramChatId: String(input.telegramChatId), boundAt: now, bindCodeHash: null, bindCodeExpiresAt: null },
  }
}

/** Is this Telegram chat the bound operator's? Fail-closed: no active binding,
 *  revoked binding, or a different/blank chat id → false (route logs a refusal). */
export function isBoundChat(
  binding: BindingRecord | null | undefined,
  telegramChatId: string | null | undefined,
): boolean {
  if (!binding || binding.revokedAt || !binding.boundAt || !binding.telegramChatId) return false
  const chat = String(telegramChatId ?? '').trim()
  if (!chat) return false
  return hashesEqual(chat, binding.telegramChatId)
}

/** Is this Cockpit user the bound operator (or, before binding completes, the
 *  operator who started it)? Owner-scoping for the Clerk-authed surface. */
export function isBoundOperator(
  binding: BindingRecord | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!binding || binding.revokedAt) return false
  const uid = String(userId ?? '').trim()
  if (!uid) return false
  return hashesEqual(uid, binding.operatorUserId)
}

// ─── Replay / nonce guard ────────────────────────────────────────────────────

/** A command nonce is fresh iff we haven't seen it before. Guards Telegram
 *  redelivery and a captured voice note replayed. Pure over a caller-supplied
 *  seen-set (the route persists nonces). */
export function isFreshNonce(seen: Set<string> | Iterable<string>, nonce: string): boolean {
  const n = String(nonce ?? '').trim()
  if (!n) return false
  const set = seen instanceof Set ? seen : new Set(seen)
  return !set.has(n)
}

// ─── /panic kill switch ──────────────────────────────────────────────────────

export interface PanicPlan {
  /** Agent status patch — pause so `canAgentRun` returns false. */
  agentPatch: { status: 'paused' }
  /** Session token-hashes to revoke (every not-yet-revoked session). */
  sessionsToRevoke: string[]
  /** Revocation patch stamped on the sessions + any in-flight runs. */
  revokePatch: { revokedAt: Date }
  /** Run statuses considered "in flight" and cancelled by panic. */
  cancelRunStatuses: string[]
}

/** Compute the effect of `/panic`: pause Arturita, revoke every live session,
 *  cancel in-flight runs. Pure — the route applies these patches. Idempotent:
 *  already-revoked sessions are skipped so a double-tap is a no-op. */
export function panicPlan(
  sessions: Array<Pick<SessionRecord, 'tokenHash' | 'revokedAt'>>,
  now: Date = new Date(),
): PanicPlan {
  return {
    agentPatch: { status: 'paused' },
    sessionsToRevoke: sessions.filter(s => !s.revokedAt).map(s => s.tokenHash),
    revokePatch: { revokedAt: now },
    cancelRunStatuses: ['running', 'queued'],
  }
}

// ─── Persona seed ────────────────────────────────────────────────────────────

/** The Arturita agent persona — one owner-scoped row per org, `agentType`
 *  'arturita'. Distinct emoji + persona text; runtime 'internal' (she runs on the
 *  existing executor). The route inserts this iff no arturita agent exists for the
 *  org (idempotent ensure). */
export function buildArturitaAgent(orgId: string, id: string, now: Date = new Date()) {
  return {
    id,
    orgId,
    name: 'Arturita',
    role: 'Personal Chief of Staff (voice-first)',
    title: 'Personal Chief of Staff',
    avatarEmoji: '🌸',
    agentType: 'arturita',
    runtime: 'internal',
    status: 'idle',
    personality:
      'Warm, precise, and safety-first. Arturita is the operator\'s voice-first personal ' +
      'agent: she reads and prepares, and always stops at anything irreversible or outward-' +
      'facing for an explicit human approval. She never signs a wallet transaction, never ' +
      'sends email without approval, and never runs a destructive machine action on her own.',
    persona:
      'You are Arturita, the operator\'s personal voice-first chief of staff. You act only ' +
      'within an approved, bounded scope. Every dangerous action (destructive file op, ' +
      'wallet transaction, email send, machine command) MUST route through the tri-state ' +
      'approval flow with a fresh session — you propose, the operator approves. Fail closed ' +
      'on ambiguity: when unsure, ask rather than act.',
    createdAt: now,
  }
}
