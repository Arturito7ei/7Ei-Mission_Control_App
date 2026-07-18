// ACT-1 — the unified activity feed.
//
// The office already WROTE its history in five places and showed almost none of it:
// approvals (filed + decided), the CONN-8b-4 connector-execution ledger, agent runs,
// tasks, and the audit trail (live since #257 — the "no-op plugin" note in older
// comments is stale). Each had its own endpoint, its own shape, or no reader at all.
// This module is the ONE place that turns those rows into a single reverse-chronological
// vocabulary, so the desk and the phone can render the same feed from the same words.
//
// Three invariants hold everything together:
//
//  1. ALLOW-LIST, always. Every projector below names each field it emits. Nothing is
//     spread, nothing is `db.select()`-ed wholesale. `approval_requests.payload`,
//     `tasks.input`/`output`, `agent_runs.logs`/`sessionState` and `audit_logs.metadata`
//     all carry raw prompts, argv, wallet destinations, recipients or request bodies —
//     none of them appear here, and a new column cannot silently ride along.
//     (Precedent: `projectConnectorExecution` in ./connector-execution.)
//
//  2. NEVER WIDEN. Connector executions and the audit trail are owner-only TODAY
//     (`requireOrgRole('owner')` on their existing routes). Folding them into a feed a
//     member can read would be a privilege escalation dressed as a UI story, so
//     OWNER_ONLY_KINDS is filtered by the route against the caller's real role.
//
//  3. BOUNDED. The feed is a (ts desc, id desc) merge with a hard cap and an opaque
//     cursor. There is no unbounded read path.

// ─── The shared vocabulary ─────────────────────────────────────────────────────

/** Every kind of thing that can appear in the feed. The web + mobile clients hand-copy
 *  this set (Metro can't import backend source); `apps/mobile/src/activityKinds.test.ts`
 *  TEXT-READs THIS array and asserts both clients equal it. Adding a kind here without
 *  adding it to both clients fails that test. */
export const ACTIVITY_KINDS = [
  'approval_filed',
  'approval_decided',
  'connector_execution',
  'agent_run',
  'task',
  'audit_event',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** The NORMALIZED outcome vocabulary. The five sources speak five different status
 *  languages (`pending`/`succeeded`/`done`/`orphaned`/HTTP codes); the feed speaks one,
 *  so a filter chip and a colour don't need a per-source lookup on each client. Also
 *  hand-copied + pinned by the same tripwire. */
export const ACTIVITY_OUTCOMES = ['pending', 'running', 'ok', 'failed', 'rejected', 'info'] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

/** Kinds whose SOURCE routes are owner-gated today. The feed must not become a side
 *  door around that gate — see invariant 2 above. */
export const OWNER_ONLY_KINDS: readonly ActivityKind[] = ['connector_execution', 'audit_event']

/** Default / maximum page size. The cap is hard: `?limit=999` yields FEED_MAX_LIMIT. */
export const FEED_DEFAULT_LIMIT = 40
export const FEED_MAX_LIMIT = 100

/** Extra rows fetched per source, on top of `limit + 1`, to absorb TIES.
 *
 *  Why it is needed: each source is queried with `at <= cursor.at` (SQL cannot express
 *  the (timestamp, feed-id) tuple comparison the merge orders by, because the feed id is
 *  source-PREFIXED and the prefix only exists in JS). Rows sharing the cursor's exact
 *  millisecond are therefore fetched and then dropped by `isAfterCursor` — and because
 *  each source is ordered by `(at desc, id desc)`, the dropped rows are always a
 *  contiguous PREFIX of what that source returned. So the slack directly bounds the
 *  failure: a page is exact unless MORE than this many rows in ONE source share the
 *  cursor's millisecond. Without it, a burst of same-millisecond writes could consume a
 *  source's whole fetch budget and permanently skip the row after them.
 *
 *  Bounded by construction — this only widens each source's read to `limit + 21`. */
export const FEED_TIE_SLACK = 20

/** How much of an (already-sanitized-at-write) error survives into a row. Same budget
 *  as the connector monitor, for the same reason: a long provider message must not
 *  dominate the view. */
export const ACTIVITY_ERROR_MAX = 200

/** Free-text fields are truncated so one runaway title can't dominate a row (or a
 *  response). Titles/summaries are caller-supplied for non-dangerous approvals and for
 *  tasks, so they are untrusted DISPLAY data — clients must escape them on render. */
export const ACTIVITY_TEXT_MAX = 200

// ─── The row shape ─────────────────────────────────────────────────────────────

/** The ONLY shape that leaves the server. Deliberately flat and source-agnostic: the
 *  clients render one row component for all six kinds.
 *
 *  What is NOT here, by construction: approval payloads, decision notes, task input /
 *  output, run logs, session state, audit metadata, params, params-digests, tokens, and
 *  any id that shouldn't leave (an approval's identity collapses to `gated` on the
 *  connector side, exactly as CONN-8b-4 does it). */
export interface ActivityEvent {
  /** Feed-local, stable, and source-prefixed so ids can't collide across tables.
   *  It is NOT the underlying row id for owner-sensitive sources — see projectors. */
  id: string
  kind: ActivityKind
  /** Epoch ms. The single sort key. */
  at: number
  /** One short human clause: what happened. */
  title: string
  /** Normalized status. */
  outcome: ActivityOutcome
  /** Which agent, if any. `agentId` is org-internal and already exposed on every
   *  existing agent surface; `agentName` saves the client a join. */
  agentId: string | null
  agentName: string | null
  /** The thing acted upon, when the kind has one: a connector id, an approval type,
   *  an HTTP path (already redacted upstream). Never a secret, never a raw param. */
  target: string | null
  /** Short, truncated, sanitized-at-write error text — or null. */
  error: string | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ms = (v: Date | number | null | undefined): number => {
  const n = v instanceof Date ? v.getTime() : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const clip = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s.length === 0) return null
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Truncating title that never returns null — a row with no title is worse than a
 *  placeholder, because it renders as an empty clickable line. */
const title = (v: unknown, fallback: string): string => clip(v, ACTIVITY_TEXT_MAX) ?? fallback

// ─── Per-source outcome normalization ──────────────────────────────────────────

/** approval_requests.status → outcome. The tri-state decision plus `pending`. */
export function approvalOutcome(status: string): ActivityOutcome {
  switch (status) {
    case 'pending': return 'pending'
    case 'approved': return 'ok'
    case 'rejected': return 'rejected'
    case 'revision_requested': return 'info'
    default: return 'info'
  }
}

/** connector_executions.status → outcome. */
export function connectorOutcome(status: string): ActivityOutcome {
  switch (status) {
    case 'running': return 'running'
    case 'succeeded': return 'ok'
    case 'failed': return 'failed'
    default: return 'info'
  }
}

/** agent_runs.status → outcome. Note `cancelled`: the schema comment lists four states
 *  but arturita.ts writes a fifth, so it is handled explicitly rather than falling
 *  through to `info`. */
export function runOutcome(status: string): ActivityOutcome {
  switch (status) {
    case 'running': return 'running'
    case 'done': return 'ok'
    case 'failed': return 'failed'
    case 'orphaned': return 'failed'
    case 'cancelled': return 'rejected'
    default: return 'info'
  }
}

/** tasks.status → outcome. */
export function taskOutcome(status: string): ActivityOutcome {
  switch (status) {
    case 'pending': return 'pending'
    case 'in_progress': return 'running'
    case 'done': return 'ok'
    case 'failed': return 'failed'
    case 'blocked': return 'rejected'
    default: return 'info'
  }
}

/** audit_logs.statusCode → outcome. An audit row records an ATTEMPT; a 4xx/5xx is the
 *  interesting one (a refused write is exactly what an owner wants to see). */
export function auditOutcome(statusCode: number | null | undefined): ActivityOutcome {
  const n = Number(statusCode ?? 0)
  if (!Number.isFinite(n) || n === 0) return 'info'
  if (n >= 500) return 'failed'
  if (n >= 400) return 'rejected'
  if (n >= 200 && n < 300) return 'ok'
  return 'info'
}

// ─── Projectors — one per source, all allow-list ───────────────────────────────

/** The FILING of an approval, at `createdAt`.
 *
 *  Outcome is `pending` only while it still awaits a decision; once decided, the filing
 *  becomes history and reads `info`. Reusing `approvalOutcome` here would be wrong: it
 *  would render a *filed* row as "approved", which is the decision's outcome, not the
 *  filing's — and the decision has its own row (below). */
export function projectApprovalFiled(row: {
  id: string; type: string; summary: string; status: string
  requestedByAgentId: string | null; createdAt: Date | number | null
}, agentName: string | null): ActivityEvent {
  return {
    id: 'apf:' + String(row.id),
    kind: 'approval_filed',
    at: ms(row.createdAt),
    title: title(row.summary, 'Approval requested'),
    outcome: String(row.status) === 'pending' ? 'pending' : 'info',
    agentId: row.requestedByAgentId ? String(row.requestedByAgentId) : null,
    agentName,
    target: clip(row.type, 64),
    error: null,
  }
}

/** An approval that HAS been decided. Sorted by `decidedAt`, not `createdAt` — the
 *  decision is the event. `decisionNote` and `decidedBy` are deliberately absent:
 *  the note is free-form reviewer prose and the decider is a user identity, neither of
 *  which belongs in a feed row. */
export function projectApprovalDecided(row: {
  id: string; type: string; summary: string; status: string
  requestedByAgentId: string | null; decidedAt: Date | number | null
}, agentName: string | null): ActivityEvent {
  return {
    id: 'apd:' + String(row.id),
    kind: 'approval_decided',
    at: ms(row.decidedAt),
    title: title(row.summary, 'Approval decided'),
    outcome: approvalOutcome(String(row.status)),
    agentId: row.requestedByAgentId ? String(row.requestedByAgentId) : null,
    agentName,
    target: clip(row.type, 64),
    error: null,
  }
}

/** A connector run from the CONN-8b-4 ledger. OWNER-ONLY (see OWNER_ONLY_KINDS).
 *  Mirrors `projectConnectorExecution`'s discipline: no approval id (it collapses into
 *  the title's gated marker), no params, no digest. */
export function projectConnectorEvent(row: {
  id: string; agentId: string; connectorId: string; action: string
  classification: string; approvalId: string | null; status: string
  error: string | null; createdAt: Date | number | null
}, agentName: string | null): ActivityEvent {
  const gated = row.approvalId != null
  return {
    id: 'cx:' + String(row.id),
    kind: 'connector_execution',
    at: ms(row.createdAt),
    title: String(row.action) + (gated ? ' (approved)' : ''),
    outcome: connectorOutcome(String(row.status)),
    agentId: String(row.agentId),
    agentName,
    target: clip(row.connectorId, 64),
    error: clip(row.error, ACTIVITY_ERROR_MAX),
  }
}

/** An agent run. `logs` and `sessionState` are never touched. */
export function projectRunEvent(row: {
  id: string; agentId: string; status: string
  startedAt: Date | number | null; endedAt: Date | number | null
}, agentName: string | null, taskTitle: string | null): ActivityEvent {
  return {
    id: 'run:' + String(row.id),
    kind: 'agent_run',
    at: ms(row.startedAt),
    title: title(taskTitle, 'Agent run'),
    outcome: runOutcome(String(row.status)),
    agentId: String(row.agentId),
    agentName,
    target: null,
    error: null,
  }
}

/** A task. `input`/`output` are never touched — `output` holds raw LLM text and, on
 *  failure, raw error text written straight through by agent-executor. */
export function projectTaskEvent(row: {
  id: string; title: string; status: string
  agentId: string | null; createdAt: Date | number | null
}, agentName: string | null): ActivityEvent {
  return {
    id: 'task:' + String(row.id),
    kind: 'task',
    at: ms(row.createdAt),
    title: title(row.title, 'Task'),
    outcome: taskOutcome(String(row.status)),
    agentId: row.agentId ? String(row.agentId) : null,
    agentName,
    target: null,
    error: null,
  }
}

/** An audit-trail entry. OWNER-ONLY (see OWNER_ONLY_KINDS).
 *
 *  `metadata` is EXCLUDED on purpose. It mirrors sanitized request BODIES across the
 *  whole mutating surface: the redaction there is key-name-driven and best-effort, and
 *  it carries PII and business payloads irrelevant to "what has my office been doing".
 *  `path` is already run through `redactPath` at write time (invite tokens become
 *  `:token`), and `userId` is dropped — the feed reports what happened, not who to
 *  blame; the dedicated `/audit-log` route remains the forensic surface. */
export function projectAuditEvent(row: {
  id: string; action: string; method: string; path: string
  statusCode: number | null; createdAt: Date | number | null
}): ActivityEvent {
  return {
    id: 'aud:' + String(row.id),
    kind: 'audit_event',
    at: ms(row.createdAt),
    title: title(row.action, 'Audit event'),
    outcome: auditOutcome(row.statusCode),
    agentId: null,
    agentName: null,
    target: clip(String(row.method) + ' ' + String(row.path), 160),
    error: null,
  }
}

// ─── The merge ─────────────────────────────────────────────────────────────────

/** The feed's total order: newest first, ties broken by id descending so the order is
 *  TOTAL and therefore stable across pages. Without the tiebreak, two rows sharing a
 *  millisecond could swap between page 1 and page 2 and one of them would be skipped. */
export function compareActivity(a: ActivityEvent, b: ActivityEvent): number {
  if (b.at !== a.at) return b.at - a.at
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export interface ActivityCursor { at: number; id: string }

/** Cursors are opaque to clients: `<epochMs>.<feedId>`. The feed id is already
 *  source-prefixed and non-sensitive. */
export function formatActivityCursor(e: ActivityEvent): string {
  return e.at + '.' + e.id
}

export function parseActivityCursor(raw: unknown): ActivityCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const dot = raw.indexOf('.')
  if (dot <= 0) return null
  const at = Number(raw.slice(0, dot))
  const id = raw.slice(dot + 1)
  if (!Number.isFinite(at) || at < 0 || id.length === 0) return null
  return { at, id }
}

/** True when `e` sorts STRICTLY AFTER the cursor position — i.e. belongs on a later
 *  page. Mirrors `compareActivity` exactly; if one changes the other must. */
export function isAfterCursor(e: ActivityEvent, c: ActivityCursor): boolean {
  if (e.at !== c.at) return e.at < c.at
  return e.id < c.id
}

/** Clamp a caller-supplied limit. Same idiom as agent-detail.ts. */
export function clampLimit(raw: unknown): number {
  return Math.min(Math.max(Number(raw) || FEED_DEFAULT_LIMIT, 1), FEED_MAX_LIMIT)
}

/** Merge every source into ONE bounded page.
 *
 *  Each source is queried independently (each already ordered desc and over-fetched by
 *  one page), then merged here. Correctness of the cursor across a multi-source merge
 *  rests on the total order above: every source is filtered to `at <= cursor.at` at the
 *  SQL layer, and the exact boundary is resolved here by `isAfterCursor`. */
export function mergeActivityPage(
  sources: ActivityEvent[][],
  opts: { limit: number; cursor?: ActivityCursor | null },
): { events: ActivityEvent[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(opts.limit, 1), FEED_MAX_LIMIT)
  let all = ([] as ActivityEvent[]).concat(...sources)
  if (opts.cursor) all = all.filter((e) => isAfterCursor(e, opts.cursor!))
  all.sort(compareActivity)
  const events = all.slice(0, limit)
  // A next cursor is offered only when this page filled AND something was left behind:
  // otherwise "Load more" would appear on a feed that has nothing more to give.
  const nextCursor =
    events.length === limit && all.length > limit ? formatActivityCursor(events[events.length - 1]) : null
  return { events, nextCursor }
}

/** Which kinds a caller may see, given their role and any explicit `kind` filter.
 *  Owner-only kinds are removed for members BEFORE any query runs, so a member's
 *  request never even reads those tables. */
export function visibleKinds(input: { isOwner: boolean; requested?: readonly string[] | null }): ActivityKind[] {
  const allowed = ACTIVITY_KINDS.filter((k) => input.isOwner || !OWNER_ONLY_KINDS.includes(k))
  const req = input.requested
  if (!req || req.length === 0) return allowed
  const wanted = new Set(req)
  return allowed.filter((k) => wanted.has(k))
}

/** Parse a `?kind=a,b` filter into known kinds. Unknown values are dropped rather than
 *  erroring — a client on an older build asking for a retired kind should degrade, not
 *  break. Returns null for "no filter". */
export function parseKindFilter(raw: unknown): ActivityKind[] | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const known = parts.filter((p): p is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(p))
  return known.length > 0 ? known : null
}
