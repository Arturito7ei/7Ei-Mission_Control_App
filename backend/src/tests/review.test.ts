import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTrustMode, isLowTrust,
  isGatedAction, LOW_TRUST_GATED_ACTIONS,
  parseBoundary, serializeBoundary, isWithinBoundary,
  renderReviewSummary, evaluateLowTrustAction, promotionOutcome,
  buildReviewCaseRow, REVIEW_CASE_TYPE,
  type TrustBoundary,
} from '../services/review'

// ─── trust mode ──────────────────────────────────────────────────────────────

test('[P1] parseTrustMode: default + unknown → standard (fail-safe, never lowers containment)', () => {
  assert.equal(parseTrustMode(undefined), 'standard')
  assert.equal(parseTrustMode(null), 'standard')
  assert.equal(parseTrustMode(''), 'standard')
  assert.equal(parseTrustMode('garbage'), 'standard')
  assert.equal(parseTrustMode('STANDARD'), 'standard')
})

test('[P1] parseTrustMode: low_trust_review recognized (case/space-insensitive)', () => {
  assert.equal(parseTrustMode('low_trust_review'), 'low_trust_review')
  assert.equal(parseTrustMode('  Low_Trust_Review '), 'low_trust_review')
  assert.equal(isLowTrust('low_trust_review'), true)
  assert.equal(isLowTrust('standard'), false)
})

// ─── gated-action taxonomy ───────────────────────────────────────────────────

test('[P1] gated taxonomy reuses A2 danger types + adds create-agents/skills + assign-tasks', () => {
  for (const t of ['file_destructive', 'wallet_tx', 'email_send', 'machine_exec', 'agent_create', 'skill_create', 'task_assign']) {
    assert.equal(isGatedAction(t), true, `${t} should be gated`)
  }
  assert.equal(LOW_TRUST_GATED_ACTIONS.length, 7)
  assert.equal(isGatedAction('read_file'), false)
  assert.equal(isGatedAction('summarize'), false)
  assert.equal(isGatedAction(undefined), false)
})

test('[P1] isGatedAction normalizes case + whitespace (matches directive emission)', () => {
  assert.equal(isGatedAction('File Destructive'), true)
  assert.equal(isGatedAction('TASK_ASSIGN'), true)
})

// ─── boundary parsing ────────────────────────────────────────────────────────

test('[P1] parseBoundary: fail-closed to EMPTY on missing/garbage (empty = touch nothing)', () => {
  assert.deepEqual(parseBoundary(undefined), { projects: [], tasks: [], agents: [] })
  assert.deepEqual(parseBoundary(null), { projects: [], tasks: [], agents: [] })
  assert.deepEqual(parseBoundary('{not json'), { projects: [], tasks: [], agents: [] })
  assert.deepEqual(parseBoundary('[1,2,3]'), { projects: [], tasks: [], agents: [] }) // array, not object
  assert.deepEqual(parseBoundary('"scalar"'), { projects: [], tasks: [], agents: [] })
})

test('[P1] parseBoundary: normalizes (trims, dedupes, drops empties) from string or object', () => {
  const b = parseBoundary('{"projects":["p1"," p1 ","","p2"],"tasks":["t1"],"agents":[]}')
  assert.deepEqual(b, { projects: ['p1', 'p2'], tasks: ['t1'], agents: [] })
  const b2 = parseBoundary({ projects: ['x'], tasks: [], agents: ['a1', 'a1'] } as TrustBoundary)
  assert.deepEqual(b2, { projects: ['x'], tasks: [], agents: ['a1'] })
})

test('[P1] serializeBoundary round-trips normalized', () => {
  const s = serializeBoundary({ projects: [' p1 ', 'p1'], tasks: ['t1'], agents: [] } as TrustBoundary)
  assert.deepEqual(parseBoundary(s), { projects: ['p1'], tasks: ['t1'], agents: [] })
})

test('[P1] isWithinBoundary: id must be listed under the matching kind; empty list = closed', () => {
  const b = parseBoundary('{"projects":["p1"],"tasks":["t1","t2"],"agents":["a1"]}')
  assert.equal(isWithinBoundary(b, { kind: 'project', id: 'p1' }), true)
  assert.equal(isWithinBoundary(b, { kind: 'project', id: 'p9' }), false)
  assert.equal(isWithinBoundary(b, { kind: 'task', id: 't2' }), true)
  assert.equal(isWithinBoundary(b, { kind: 'agent', id: 'a1' }), true)
  assert.equal(isWithinBoundary(b, { kind: 'agent', id: 'a2' }), false)
  // a task id is NOT reachable just because it matches a project id namespace
  assert.equal(isWithinBoundary(parseBoundary('{"projects":["shared"]}'), { kind: 'task', id: 'shared' }), false)
  assert.equal(isWithinBoundary(b, { kind: 'task', id: '' }), false)
})

// ─── evaluate: standard-trust is inert ───────────────────────────────────────

test('[P1] standard-trust agent → allow even for a dangerous action (this gate is inert)', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'standard', boundary: null,
    action: { type: 'file_destructive', payload: { op: 'delete', count: 3 } },
  })
  assert.equal(r.decision, 'allow')
  assert.equal(r.requiresStepUp, false)
})

// ─── evaluate: fail-closed on malformed action ───────────────────────────────

test('[P1] malformed / missing action → refuse (fail-closed)', () => {
  assert.equal(evaluateLowTrustAction({ trustMode: 'low_trust_review', boundary: '{}', action: null }).decision, 'refuse')
  assert.equal(evaluateLowTrustAction({ trustMode: 'low_trust_review', boundary: '{}', action: {} as any }).decision, 'refuse')
})

// ─── evaluate: boundary escape ───────────────────────────────────────────────

test('[P1] low-trust boundary escape → refuse (contained; cannot reach outside its set)', () => {
  const boundary = '{"projects":["p1"],"tasks":["t1"],"agents":["a1"]}'
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review', boundary,
    action: { type: 'summarize', resources: [{ kind: 'task', id: 't-OUTSIDE' }] },
  })
  assert.equal(r.decision, 'refuse')
  assert.match(r.reason, /boundary escape/)
})

test('[P1] escape wins over gated — an out-of-boundary dangerous action is REFUSED, not quarantined', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review', boundary: '{"projects":["p1"]}',
    action: { type: 'file_destructive', resources: [{ kind: 'project', id: 'p9' }], payload: { op: 'delete', count: 1 } },
  })
  assert.equal(r.decision, 'refuse')
})

test('[P1] empty boundary → a low-trust agent touching ANY resource is refused', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review', boundary: undefined,
    action: { type: 'summarize', resources: [{ kind: 'project', id: 'anything' }] },
  })
  assert.equal(r.decision, 'refuse')
})

// ─── evaluate: quarantine ────────────────────────────────────────────────────

test('[P1] in-boundary gated action → quarantine with a machine-rendered summary', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review',
    boundary: '{"agents":["a1"]}',
    action: { type: 'task_assign', resources: [{ kind: 'agent', id: 'a1' }], payload: { targetName: 'Dev', task: 'ship the thing' } },
  })
  assert.equal(r.decision, 'quarantine')
  assert.equal(r.requiresStepUp, false) // task_assign is gated but not an A2 danger class
  assert.match(r.summary ?? '', /Assign task to Dev/)
})

test('[P1] quarantined DANGEROUS class still requires step-up (never a cheaper path to danger)', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review',
    boundary: '{"projects":["p1"]}',
    action: { type: 'file_destructive', resources: [{ kind: 'project', id: 'p1' }], payload: { op: 'delete', count: 2, bytes: 2048 } },
  })
  assert.equal(r.decision, 'quarantine')
  assert.equal(r.requiresStepUp, true)
  assert.match(r.summary ?? '', /Delete 2 items/)
})

test('[P1] gated action with no resources is still quarantined (nothing to escape, but gated)', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review', boundary: '{}',
    action: { type: 'agent_create', payload: { name: 'Spawn', role: 'worker' } },
  })
  assert.equal(r.decision, 'quarantine')
  assert.match(r.summary ?? '', /Create agent "Spawn"/)
})

// ─── evaluate: allow (in-boundary, non-gated) ────────────────────────────────

test('[P1] in-boundary non-gated action → allow', () => {
  const r = evaluateLowTrustAction({
    trustMode: 'low_trust_review',
    boundary: '{"tasks":["t1"]}',
    action: { type: 'read_file', resources: [{ kind: 'task', id: 't1' }] },
  })
  assert.equal(r.decision, 'allow')
})

// ─── review-card summaries (verbatim, never prose) ───────────────────────────

test('[P1] renderReviewSummary reuses A2 renderers for danger classes', () => {
  const r = renderReviewSummary({ type: 'email_send', payload: { to: ['x@y.com'], subject: 'Hi', external: true } })
  assert.equal(r.ok, true)
  assert.match(r.summary ?? '', /Send email to x@y.com — "Hi"/)
})

test('[P1] renderReviewSummary fail-SAFE on unrenderable danger payload (generic line, not prose)', () => {
  const r = renderReviewSummary({ type: 'file_destructive', payload: { op: 'nonsense' } })
  assert.equal(r.ok, true)
  assert.match(r.summary ?? '', /Low-trust file_destructive action \(details unavailable\)/)
  assert.ok((r.warnings ?? []).length > 0)
})

test('[P1] renderReviewSummary handles the low-trust additions', () => {
  assert.match(renderReviewSummary({ type: 'skill_create', payload: { name: 'exfil' } }).summary ?? '', /Create \/ import skill "exfil"/)
  assert.match(renderReviewSummary({ type: 'agent_create', payload: {} }).summary ?? '', /Create agent "unnamed"/)
})

// ─── promotion outcome ───────────────────────────────────────────────────────

test('[P1] promotionOutcome maps tri-state decision → queue outcome', () => {
  assert.equal(promotionOutcome('approved'), 'promote')
  assert.equal(promotionOutcome('rejected'), 'discard')
  assert.equal(promotionOutcome('revision_requested'), 'revise')
  assert.equal(promotionOutcome('pending'), 'pending')
  assert.equal(promotionOutcome(undefined), 'pending')
})

test('[P1] REVIEW_CASE_TYPE is the shared approvals type (reuses the queue, no parallel store)', () => {
  assert.equal(REVIEW_CASE_TYPE, 'low_trust_review')
})

test('[P1] buildReviewCaseRow shapes a pending approval carrying requiresStepUp for danger classes', () => {
  const now = new Date(1700000000000)
  const evalr = evaluateLowTrustAction({
    trustMode: 'low_trust_review', boundary: '{"projects":["p1"]}',
    action: { type: 'file_destructive', resources: [{ kind: 'project', id: 'p1' }], payload: { op: 'delete', count: 1 } },
  })
  const row = buildReviewCaseRow({ id: 'rc1', orgId: 'o1', agentId: 'ag1', action: { type: 'file_destructive', resources: [{ kind: 'project', id: 'p1' }], payload: { op: 'delete', count: 1 } }, evaluation: evalr, now })
  assert.equal(row.type, 'low_trust_review')
  assert.equal(row.status, 'pending')
  assert.equal(row.requestedByAgentId, 'ag1')
  assert.equal((row.payload as any).requiresStepUp, true)
  assert.equal((row.payload as any).lowTrustReview, true)
  assert.equal((row.payload as any).actionType, 'file_destructive')
  assert.match(row.summary, /Delete 1 item/)
  assert.equal(row.createdAt.getTime(), 1700000000000)
})

test('[P1] buildReviewCaseRow falls back to a generic summary when the evaluation had none', () => {
  const row = buildReviewCaseRow({
    id: 'rc2', orgId: 'o1', agentId: 'ag1',
    action: { type: 'task_assign' },
    evaluation: { decision: 'quarantine', reason: 'x', requiresStepUp: false },
    now: new Date(0),
  })
  assert.equal(row.summary, 'Low-trust action held for review')
})
