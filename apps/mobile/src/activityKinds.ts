// ACT-1 — the phone's copy of the activity-feed vocabulary.
//
// HAND-COPIED from backend/src/services/activity.ts (ACTIVITY_KINDS / ACTIVITY_OUTCOMES
// / OWNER_ONLY_KINDS). Metro can't import backend source and the browser bundle won't
// either, so this is a copy — pinned by a drift tripwire that reads the backend source
// as TEXT and asserts EQUALITY, not subset: apps/mobile/src/activityKinds.test.ts.
//
// KEEP THIS FILE IMPORT-FREE, for TWO reasons that both bite:
//   - activityKinds.test.ts loads it under `node --test`, which needs explicit `.ts`
//     extensions on sibling imports — and tsc rejects those outside the excluded test
//     files (the mobile .ts-extension trap; see the header of activity.ts).
//   - the same rule that governs web/lib/activityKinds.ts: Mobile CI installs only this
//     workspace, so an import would silently drop the parity test rather than fail it.
// Asserted, not merely requested: the tripwire greps both copies for an import statement.
//
// Screens import this normally (`from './activityKinds'`) — .tsx files are never loaded
// by `node --test`, so they are unaffected by the extension rule.

export const ACTIVITY_KINDS = [
  'approval_filed',
  'approval_decided',
  'connector_execution',
  'agent_run',
  'task',
  'audit_event',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const ACTIVITY_OUTCOMES = ['pending', 'running', 'ok', 'failed', 'rejected', 'info'] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

/** Kinds the server drops for a non-owner. The client uses this only to EXPLAIN the
 *  absence ("owner-only") — never to decide access. The server decides. */
export const OWNER_ONLY_KINDS: readonly ActivityKind[] = ['connector_execution', 'audit_event']

/** One row of the feed — mirrors `ActivityEvent` in backend/src/services/activity.ts. */
export interface ActivityEvent {
  id: string
  kind: ActivityKind
  at: number
  title: string
  outcome: ActivityOutcome
  agentId: string | null
  agentName: string | null
  target: string | null
  error: string | null
}

/** Human labels for the filter chips and row badges. Display-only, so these are NOT
 *  parity-pinned to the backend — only the KEYS above are. */
export const KIND_LABEL: Record<ActivityKind, string> = {
  approval_filed: 'Approval filed',
  approval_decided: 'Decision',
  connector_execution: 'Connector',
  agent_run: 'Agent run',
  task: 'Task',
  audit_event: 'Audit',
}

export const KIND_GLYPH: Record<ActivityKind, string> = {
  approval_filed: '🛡',
  approval_decided: '⚖',
  connector_execution: '🔌',
  agent_run: '▶',
  task: '📋',
  audit_event: '📜',
}

/** The one phrase that means "the operator must act". Named because exactly one
 *  kind/outcome pair may ever carry it — see OUTCOME_LABEL_BY_KIND, and the test that
 *  pins that set to a single member. */
export const AWAITING_DECISION = 'Awaiting decision'

/** The DEFAULT badge copy, read when a kind has no override below. */
export const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  pending: 'Queued',
  running: 'Running',
  ok: 'OK',
  failed: 'Failed',
  rejected: 'Refused',
  info: 'Logged',
}

/** FIX-1 — per-KIND overrides, because one outcome word means two different things.
 *
 *  The live bug this closes: the Inbox read "Nothing needs a decision right now" while
 *  the Activity feed, one click away, showed SIX rows badged "Awaiting decision". Both
 *  were telling the truth and the shared label was lying. `tasks.status` DEFAULTS to
 *  'pending' (backend/src/db/schema.ts), so every task is born pending — it means
 *  QUEUED, waiting for an AGENT to pick it up. Only `approval_filed` + 'pending' means
 *  waiting for the OPERATOR, and that is the set the Inbox lists. Rendering both with
 *  the operator's phrase turned routine queue depth into six phantom obligations and
 *  made the one surface whose entire job is to be trusted look wrong.
 *
 *  Same class, same fix, for the other two collisions:
 *    - a task at 'blocked' normalises to `rejected`; nobody refused it, it is BLOCKED.
 *    - an agent_run at 'cancelled' normalises to `rejected`; it was CANCELLED.
 *
 *  Note the DIRECTION. The obvious shape — leave 'Awaiting decision' as the default and
 *  override it for `task` — was written first and a test rejected it: every OTHER kind
 *  still inherited the operator's phrase, so the contradiction was one new kind away
 *  from returning. The phrase is now GRANTED to the single row shape that earns it and
 *  the default is the neutral reading, which fails safe: a kind added later cannot
 *  silently claim to want a decision. Everything else falls through to the default. */
export const OUTCOME_LABEL_BY_KIND: Partial<Record<ActivityKind, Partial<Record<ActivityOutcome, string>>>> = {
  approval_filed: { pending: AWAITING_DECISION },
  task: { rejected: 'Blocked' },
  agent_run: { rejected: 'Cancelled' },
}

/** The badge copy for a row. TOTAL over kind × outcome — a row always gets a word.
 *
 *  Callers pass the row's own kind rather than indexing OUTCOME_LABEL directly; that
 *  indexing is what produced the contradiction described above. */
export function outcomeLabel(kind: ActivityKind, outcome: ActivityOutcome): string {
  return OUTCOME_LABEL_BY_KIND[kind]?.[outcome] ?? OUTCOME_LABEL[outcome] ?? String(outcome)
}

/** Does this row actually await the OPERATOR? The one predicate that answers the
 *  question the old badge only appeared to answer. Deliberately narrow: a filed
 *  approval still sitting at 'pending' is the entire set the Inbox decides on, so this
 *  and the Inbox cannot disagree without a test failing. */
export function awaitsOperator(e: { kind: ActivityKind; outcome: ActivityOutcome }): boolean {
  return e.kind === 'approval_filed' && e.outcome === 'pending'
}

// NOTE: there is deliberately no OUTCOME_TONE here. Colour tone is the ONE piece of
// this vocabulary that is genuinely surface-specific — the web's Pill takes
// 'ok'|'fail'|'warn'|'muted', the phone's Chip takes 'ok'|'warn'|'danger' — so a shared
// tone map would have to invent a third vocabulary that neither surface actually uses,
// and would drift from both. Each surface maps outcome to its own tone locally; what
// must be identical (the kinds, the outcomes, the owner-only set, the copy) is here.

export function isActivityKind(v: unknown): v is ActivityKind {
  return typeof v === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(v)
}

/** Relative age, in the phone's idiom, shared so both surfaces read identically. */
export function activityAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

/** Build the activity-feed query string. SHARED so the desk and the phone provably hit
 *  the endpoint the same way — same param names, same clamp, same "all means omit"
 *  rule. A divergence here is the classic parity bug: two surfaces that look identical
 *  but silently ask different questions. Pinned by activityKinds.test.ts. */
export function activityQuery(input: {
  kind?: ActivityKind | 'all' | null
  agentId?: string | null
  cursor?: string | null
  limit?: number
}): string {
  const parts: string[] = ['limit=' + String(Math.min(Math.max(input.limit ?? 40, 1), 100))]
  if (input.kind && input.kind !== 'all' && isActivityKind(input.kind)) parts.push('kind=' + encodeURIComponent(input.kind))
  if (input.agentId && input.agentId !== 'all') parts.push('agentId=' + encodeURIComponent(input.agentId))
  if (input.cursor) parts.push('cursor=' + encodeURIComponent(input.cursor))
  return parts.join('&')
}

// ─── FIX-1 — making the audit trail LEGIBLE without removing any of it ─────────
//
// Live, the feed was ~70% plumbing: repeated rows reading `post.orgs` with a target of
// `POST /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/arturita/converse`. The signal —
// a task failed, a decision is waiting — was buried under machine strings. The owner
// explicitly asked for audit logs, so NOTHING is dropped here and the server payload is
// untouched: these are pure DISPLAY helpers, and the kind filter still reaches every row.

/** The org id is implicit (the whole feed is org-scoped) and a bare uuid is noise, so
 *  path segments that are ids get elided rather than shown. Matches a uuid, and also the
 *  long opaque ids this API mints elsewhere. */
function isIdSegment(seg: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true
  return seg.length >= 16 && /^[0-9a-zA-Z_-]+$/.test(seg) && /\d/.test(seg) && /[a-zA-Z]/.test(seg)
}

/** Split an audit row's `target` ("POST /api/orgs/<uuid>/arturita/converse") into the
 *  method and a human resource path ("arturita › converse").
 *
 *  Deliberately GENERAL — it elides ids and the `/api/orgs/<id>` prefix and prettifies
 *  what is left, rather than special-casing endpoints. A per-endpoint phrasebook would
 *  go stale silently the moment a route is added, and would then render the new route as
 *  nothing at all; this degrades to "the path, minus the noise", which is always true. */
export function auditTarget(target: string | null | undefined): { method: string | null; resource: string | null } {
  const raw = String(target ?? '').trim()
  if (!raw) return { method: null, resource: null }
  const m = /^([A-Z]+)\s+(\/\S*)$/.exec(raw)
  if (!m) return { method: null, resource: raw }
  const method = m[1]
  const segs = m[2].split('/').filter(Boolean)
  const start = segs[0] === 'api' ? 1 : 0
  const kept = segs.slice(start).filter((s, i, a) => {
    if (isIdSegment(s)) return false
    // `orgs` immediately followed by the org id carries no information in an org-scoped
    // feed. `orgs` NOT followed by an id (the collection itself) is kept.
    if (s === 'orgs' && a[i + 1] && isIdSegment(a[i + 1])) return false
    return true
  })
  const resource = kept.map(s => s.replace(/[-_]+/g, ' ')).join(' › ')
  return { method, resource: resource || '/' }
}

/** The one-line phrase for an audit row: method + human resource, falling back to the
 *  row's own title when the target is unparseable (never an empty row). */
export function auditPhrase(title: string, target: string | null | undefined): string {
  const { method, resource } = auditTarget(target)
  if (!resource) return title
  return method ? method + ' ' + resource : resource
}

/** A run of consecutive `audit_event` rows, collapsed into one line.
 *
 *  `items` is retained in full — expanding is a client-side toggle, not a refetch, so
 *  nothing is hidden from the operator that a click cannot recover. */
export interface AuditRun { key: string; count: number; items: ActivityEvent[] }
export type FeedRow = { row: 'event'; event: ActivityEvent } | { row: 'auditRun'; run: AuditRun }

/** Collapse consecutive audit rows so the default view leads with what happened rather
 *  than with plumbing. Two rules keep this honest:
 *
 *   - it only ever collapses `audit_event`, and only RUNS of 2+. A lone audit row between
 *     two real events stays exactly where it is; hiding it would cost a line and save
 *     nothing.
 *   - `collapse: false` (which the Audit filter chip passes) is a strict pass-through, so
 *     asking for audit rows explicitly always shows every one of them, expanded. The
 *     filter remains the way to get the raw trail, exactly as before.
 *
 *  ORDER IS NEVER CHANGED — rows come out in the order they went in. The feed is
 *  chronological and reordering it would be a worse lie than the noise. */
export function buildFeedRows(events: readonly ActivityEvent[], opts?: { collapse?: boolean }): FeedRow[] {
  const collapse = opts?.collapse !== false
  const out: FeedRow[] = []
  let i = 0
  while (i < events.length) {
    const e = events[i]
    if (!collapse || e.kind !== 'audit_event') { out.push({ row: 'event', event: e }); i++; continue }
    let j = i
    while (j < events.length && events[j].kind === 'audit_event') j++
    const items = events.slice(i, j)
    if (items.length < 2) out.push({ row: 'event', event: e })
    else out.push({ row: 'auditRun', run: { key: 'run:' + items[0].id, count: items.length, items } })
    i = j
  }
  return out
}

/** The collapsed line's copy. Says what it is and that it is routine — the operator
 *  should be able to skip it without wondering whether he just skipped something. */
export function auditRunLabel(count: number): string {
  return count + ' routine audit ' + (count === 1 ? 'event' : 'events')
}
