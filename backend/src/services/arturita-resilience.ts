// Arturita F2 — degraded / offline modes + watchdog attach (pure).
//
// Keeps Arturita usable when the network, a cloud connector, or the local host
// is unavailable (PRD §7.6): conversational replies keep working on the local
// LLM/STT/TTS, while actions that need cloud connectors (Gmail, calendar, wallet
// RPC) are QUEUED with a spoken "queued, will run when back online" and replayed
// idempotently on reconnect. Host actions fail closed when the host is down.
//
// Pure decision helpers only — the executor/scheduler wire them to the queue
// table + the existing watchdog sweep. Reuses `watchdogs.ts` (no new sweep).

import { parseWatchdogSpec, type WatchdogSpec } from './watchdogs'

// ─── Action connectivity requirements ────────────────────────────────────────

/** What an action needs to run. `local` = the local LLM/STT/TTS can serve it
 *  offline (conversation, read from memory). `cloud` = a cloud connector (Gmail,
 *  calendar, RPC). `host` = the local machine host daemon. */
export type ActionNeed = 'local' | 'cloud' | 'host'

// Map action kinds to what they require. Unknown kinds default to 'cloud' (the
// safe direction — queue rather than run blind).
const ACTION_NEEDS: Record<string, ActionNeed> = {
  answer: 'local',
  chat: 'local',
  summarize: 'local',
  memory_read: 'local',
  gmail_send: 'cloud',
  gmail_read: 'cloud',
  calendar_read: 'cloud',
  wallet_read: 'cloud',
  wallet_prepare: 'cloud',
  file_op: 'host',
  machine_exec: 'host',
}

export function actionNeed(kind: string | null | undefined): ActionNeed {
  return ACTION_NEEDS[String(kind ?? '').trim()] ?? 'cloud'
}

// ─── Connectivity routing ────────────────────────────────────────────────────

export interface Connectivity {
  online: boolean   // backend ↔ internet / cloud connectors reachable
  hostUp: boolean   // Arturita Local Host daemon reachable
}

export type Disposition = 'run' | 'queue' | 'refuse'

export interface ConnectivityDecision {
  disposition: Disposition
  spoken: string    // what Arturita says aloud
  reason: string
}

/**
 * Decide how to handle an action given current connectivity:
 *  - local action → always `run` (works offline).
 *  - cloud action offline → `queue` (replays on reconnect); online → `run`.
 *  - host action with host down → `refuse` (fail closed, spoken reason); host up
 *    → `run`. (Cloud being down never blocks a host action, and vice-versa.)
 * Pure.
 */
export function routeForConnectivity(input: {
  actionKind: string
  connectivity: Connectivity
}): ConnectivityDecision {
  const need = actionNeed(input.actionKind)
  const { online, hostUp } = input.connectivity

  if (need === 'local') {
    return { disposition: 'run', spoken: '', reason: 'local action — runs offline' }
  }
  if (need === 'host') {
    if (hostUp) return { disposition: 'run', spoken: '', reason: 'host up — runs' }
    return {
      disposition: 'refuse',
      spoken: "I can't do that right now — the machine host is offline. Read-only cloud actions still work.",
      reason: 'host down — file/machine actions fail closed',
    }
  }
  // cloud
  if (online) return { disposition: 'run', spoken: '', reason: 'online — runs' }
  return {
    disposition: 'queue',
    spoken: "We're offline, so I've queued that — it'll run when we're back online.",
    reason: 'offline — cloud action queued for replay',
  }
}

// ─── Offline queue + idempotent replay ───────────────────────────────────────

export interface QueuedAction {
  nonce: string       // dedupe key — a replayed/duplicated action runs at most once
  kind: string
  payload?: unknown
  queuedAt: number
}

/** Build a queue entry for a deferred action. The nonce guards exactly-once
 *  replay (a captured/redelivered action can't double-run). */
export function buildQueuedAction(input: { nonce: string; kind: string; payload?: unknown; now: number }): QueuedAction {
  return { nonce: String(input.nonce), kind: input.kind, payload: input.payload, queuedAt: input.now }
}

export interface ReplayPlan {
  toRun: QueuedAction[]
  skippedDuplicate: QueuedAction[]
}

/**
 * On reconnect, plan which queued actions to replay: run each once, in queue
 * order, skipping any whose nonce is already applied (idempotent — exactly-once).
 * Also de-dupes within the batch itself. Pure over a snapshot of applied nonces.
 */
export function planReplay(input: {
  queued: QueuedAction[]
  appliedNonces: Iterable<string>
}): ReplayPlan {
  const applied = new Set(input.appliedNonces)
  const seen = new Set<string>()
  const toRun: QueuedAction[] = []
  const skippedDuplicate: QueuedAction[] = []
  for (const a of input.queued) {
    if (applied.has(a.nonce) || seen.has(a.nonce)) { skippedDuplicate.push(a); continue }
    seen.add(a.nonce)
    toRun.push(a)
  }
  return { toRun, skippedDuplicate }
}

// ─── Watchdog attach for long Arturita tasks ─────────────────────────────────

/** Default watchdogs attached to a long/expensive Arturita task: runtime, cost,
 *  and no-activity. Thresholds are conservative defaults the operator can tune.
 *  Reuses `parseWatchdogSpec` so specs stay valid + consistent with W4. */
export function defaultArturitaWatchdogs(opts: {
  runtimeMin?: number
  costUsd?: number
  noActivityMin?: number
} = {}): WatchdogSpec[] {
  const runtimeMin = opts.runtimeMin ?? 15
  const costUsd = opts.costUsd ?? 1
  const noActivityMin = opts.noActivityMin ?? 10
  return [
    parseWatchdogSpec({ kind: 'runtime', threshold: String(runtimeMin) }),
    parseWatchdogSpec({ kind: 'cost', threshold: String(costUsd) }),
    parseWatchdogSpec({ kind: 'no_activity', threshold: String(noActivityMin) }),
  ]
}
