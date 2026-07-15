// Unit coverage for the surface-wide membership gate primitives in middleware/rbac.ts.
// The behavioural, driven end-to-end coverage lives in membership-scoping.test.ts;
// this file pins the fail-closed SEMANTICS of the two building blocks in isolation,
// with an injected fake DB so no server or real database is needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRequestOrg, requireOrgMembership } from '../middleware/rbac'

// A minimal stand-in for `db` — only the relational `.query.{agents,tasks}.findFirst`
// surface `resolveRequestOrg` touches. Rows are looked up by the id in the where-eq.
function fakeDb(rows: { agents?: Record<string, any>; tasks?: Record<string, any> }) {
  const find = (table: Record<string, any> | undefined) => async () => {
    // resolveRequestOrg builds `eq(col, id)`; we can't cheaply read the id back out of
    // the drizzle expression here, so the fake returns the single seeded row (tests seed
    // exactly one) or undefined when the table is empty.
    const vals = table ? Object.values(table) : []
    return vals[0]
  }
  return {
    query: {
      agents: { findFirst: find(rows.agents) },
      tasks: { findFirst: find(rows.tasks) },
    },
  } as any
}

// ─── resolveRequestOrg ───────────────────────────────────────────────────────

test('[MCA-R4] resolveRequestOrg: :orgId path param wins, no DB read needed', async () => {
  const r = await resolveRequestOrg({ orgId: 'org-42' }, fakeDb({}))
  assert.deepEqual(r, { scoped: true, orgId: 'org-42' })
})

test('[MCA-R4] resolveRequestOrg: derives org from the :agentId record', async () => {
  const r = await resolveRequestOrg({ agentId: 'a1' }, fakeDb({ agents: { a1: { id: 'a1', orgId: 'org-a' } } }))
  assert.deepEqual(r, { scoped: true, orgId: 'org-a' })
})

test('[MCA-R4] resolveRequestOrg: derives org from the :taskId record', async () => {
  const r = await resolveRequestOrg({ taskId: 't1' }, fakeDb({ tasks: { t1: { id: 't1', orgId: 'org-t' } } }))
  assert.deepEqual(r, { scoped: true, orgId: 'org-t' })
})

test('[MCA-R4] resolveRequestOrg: a MISSING record is scoped-but-null → fail closed downstream (never a skip)', async () => {
  const r = await resolveRequestOrg({ agentId: 'ghost' }, fakeDb({ /* no agents */ }))
  assert.deepEqual(r, { scoped: true, orgId: null }, 'an agentId that resolves to no row must NOT become an ungated request')
})

test('[MCA-R4] resolveRequestOrg: no org-identifying param → scoped:false (user/global route, left alone)', async () => {
  assert.deepEqual(await resolveRequestOrg({ userId: 'u1' }, fakeDb({})), { scoped: false })
  assert.deepEqual(await resolveRequestOrg({}, fakeDb({})), { scoped: false })
  assert.deepEqual(await resolveRequestOrg(undefined, fakeDb({})), { scoped: false })
})

test('[MCA-R4] resolveRequestOrg: :orgId takes precedence over :agentId (path org wins, no derivation)', async () => {
  // A route like /api/orgs/:orgId/agents/:agentId/* — the PATH org is authoritative.
  const r = await resolveRequestOrg({ orgId: 'org-path', agentId: 'a1' }, fakeDb({ agents: { a1: { orgId: 'org-other' } } }))
  assert.deepEqual(r, { scoped: true, orgId: 'org-path' })
})

// ─── requireOrgMembership (the preHandler) ───────────────────────────────────

/** A fake reply that records the first code()/send() it receives. */
function fakeReply() {
  const state: { code?: number; body?: any } = {}
  const reply: any = {
    code(c: number) { state.code = c; return reply },
    send(b: any) { state.body = b; return reply },
  }
  return { reply, state }
}

test('[MCA-R4] requireOrgMembership: OPTIONS (CORS preflight) is skipped — never touches auth', async () => {
  const { reply, state } = fakeReply()
  await requireOrgMembership({ method: 'OPTIONS', params: { orgId: 'o' } } as any, reply)
  assert.equal(state.code, undefined, 'a preflight must pass untouched (no 401/403)')
})

test('[MCA-R4] requireOrgMembership: no authenticated user → 401', async () => {
  const { reply, state } = fakeReply()
  await requireOrgMembership({ method: 'GET', params: { orgId: 'o' }, auth: undefined } as any, reply)
  assert.equal(state.code, 401)
})

test('[MCA-R4] requireOrgMembership: a route with no org context is allowed through (no code set)', async () => {
  const { reply, state } = fakeReply()
  // No orgId/agentId/taskId param → scoped:false → the gate stands down.
  await requireOrgMembership({ method: 'GET', params: { userId: 'u1' }, auth: { userId: 'u1' } } as any, reply)
  assert.equal(state.code, undefined)
})
