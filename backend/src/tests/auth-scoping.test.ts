import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'

// ─── Auth-scoping lock-down (MCA-85 hardening) ───────────────────────────────
//
// D1's /api/openapi.json surfaced that several org/agent-scoped route groups
// (jira, gmail/comms, notifications, memory, webhooks, usage, skills) were
// registered in the PUBLIC scope — reachable with no Clerk session. This suite
// is the regression net so tenant data never silently becomes public again:
//
//  1. Boot every route group the way src/index.ts does (with the three
//     recordRoute onRoute hooks) and assert the collected route table tags every
//     tenant-scoped path (`:orgId` / `:agentId`) as authenticated — Clerk or the
//     agent token — except a small, explicit public allowlist (webhook receivers
//     + the Google OAuth handshake).
//  2. Prove the secured scope actually enforces: an unauthenticated request to a
//     moved route returns 401, while a public webhook receiver is not gated.

import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, authRoutes, credentialRoutes } from '../routes/all'
import { knowledgeRoutes } from '../routes/knowledge'
import { commsRoutes, commsWebhookRoutes } from '../routes/comms'
import { connectorRoutes } from '../routes/connectors'
import { notificationRoutes } from '../routes/notifications'
import { jiraRoutes } from '../routes/jira'
import { jiraWebhookRoutes, jiraEventRoutes } from '../routes/jira-webhook'
import { memoryRoutes } from '../routes/memory'
import { multiOrgRoutes } from '../routes/multi-org'
import { usageRoutes } from '../middleware/ratelimit'
import { scheduledRoutes, routineTriggerRoutes } from '../routes/scheduled'
import { webhookRoutes } from '../routes/webhooks'
import { telegramWebhookRoutes } from '../routes/telegram-webhook'
import { arturitaRoutes, arturitaPublicRoutes } from '../routes/arturita'
import { arturitaWalletRoutes } from '../routes/arturita-wallet'
import { arturitaVoiceRoutes } from '../routes/arturita-voice'
import { agentApiRoutes } from '../routes/agent-api'
import { agentInviteRoutes, adapterRegistryRoutes, agentInviteDocRoutes, agentJoinRoutes } from '../routes/agent-invites'
import { auditLogPlugin, auditLogQueryRoutes } from '../middleware/audit-log'
import { telemetryPlugin, telemetryQueryRoutes } from '../services/telemetry'
import { PUBLIC_JOIN_IMPLEMENTED, TOKEN_CLAIM_IMPLEMENTED } from '../services/deployment-profile'
import { recordRoute, collectedRoutes, resetOpenApi } from '../services/openapi'
import { createClerkAuth } from '../middleware/clerk-auth'

// Tenant-scoped routes that are intentionally reachable without a Clerk session.
// Keep this list SHORT and justified — every entry is an external caller that
// cannot present a user session: an inbound webhook receiver, or a step of the
// Google OAuth redirect handshake. `${METHOD} ${url}` (Fastify path syntax).
const PUBLIC_TENANT_ALLOWLIST = new Set([
  'POST /api/jira/webhook/:orgId',       // Jira posts issue events here
  'POST /api/telegram/webhook/:orgId',   // Telegram posts updates here
  'GET /api/orgs/:orgId/auth/google',    // returns the Google consent URL
  'GET /api/orgs/:orgId/auth/google/status', // connection status for the OAuth UI
  // Arturita /panic kill switch — reachable off-session (voice/Telegram in D1);
  // owner-authed INSIDE the handler via a valid command-session token (minting
  // one requires Clerk). It only ever removes capability, so being public+authed
  // is safe by design, and must stay reachable even when a Clerk session isn't.
  'POST /api/orgs/:orgId/arturita/panic',
])

// Mirror src/index.ts wiring: baseline 'none' hook for all routes, a Clerk-tagged
// secured scope, and an agentToken-tagged scope around the agent API.
async function bootLikeIndex() {
  const app = Fastify({ logger: false })
  app.addHook('onRoute', (r) => recordRoute('none', r.method, r.url))
  await app.register(websocket)
  await app.register(multipart)

  await app.register(async (secured) => {
    secured.addHook('onRoute', (r) => recordRoute('clerk', r.method, r.url))
    await secured.register(orgRoutes)
    await secured.register(agentRoutes)
    await secured.register(taskRoutes)
    await secured.register(projectRoutes)
    await secured.register(costRoutes)
    await secured.register(knowledgeRoutes)
    await secured.register(multiOrgRoutes)
    await secured.register(scheduledRoutes)
    await secured.register(credentialRoutes)
    await secured.register(connectorRoutes)
    await secured.register(jiraRoutes)
    await secured.register(jiraEventRoutes)
    await secured.register(commsRoutes)
    await secured.register(notificationRoutes)
    await secured.register(memoryRoutes)
    await secured.register(webhookRoutes)
    await secured.register(usageRoutes)
    await secured.register(skillRoutes)
    await secured.register(arturitaRoutes)
    await secured.register(arturitaWalletRoutes)
    await secured.register(arturitaVoiceRoutes)
    await secured.register(agentInviteRoutes)   // Epic ONB — owner-gated invites
    // ONB2 audit H-2 — the audit-log + trace READ routes. They were registered
    // inside the hook plugins, in the public block, and this guard never booted
    // those plugins — which is exactly why it missed an unauthenticated,
    // `:orgId`-scoped audit read. Both plugins are booted below now, so the guard
    // can never again be blind to a plugin-registered route.
    await secured.register(auditLogQueryRoutes)
    await secured.register(telemetryQueryRoutes)
  })

  await app.register(commsWebhookRoutes)
  await app.register(jiraWebhookRoutes)
  await app.register(arturitaPublicRoutes)
  await app.register(adapterRegistryRoutes)     // Epic ONB — public: the static adapter taxonomy
  await app.register(agentInviteDocRoutes)      // Epic ONB / ONB2 — public: the token-addressed doc
  await app.register(agentJoinRoutes)           // Epic ONB / ONB3 — public: the join request (mints nothing)
  await app.register(async (agentScope) => {
    agentScope.addHook('onRoute', (r) => recordRoute('agentToken', r.method, r.url))
    await agentScope.register(agentApiRoutes)
  })
  await app.register(routineTriggerRoutes)
  await app.register(authRoutes)
  // The hook plugins, in the public block, exactly as src/index.ts registers them.
  // A no-op sink so the guard never reaches Turso; the ROUTES are what it tags.
  await app.register(telemetryPlugin)
  await app.register(auditLogPlugin, { sink: () => {} })

  await app.ready()
  return app
}

test('[MCA-85] no tenant-scoped route is publicly reachable outside the allowlist', async () => {
  resetOpenApi()
  const app = await bootLikeIndex()
  await app.close()

  const tenantScoped = collectedRoutes().filter(r => /:orgId|:agentId/.test(r.url))
  assert.ok(tenantScoped.length > 20, `expected many tenant-scoped routes, got ${tenantScoped.length}`)

  const leaks = tenantScoped.filter(r =>
    r.auth === 'none' && !PUBLIC_TENANT_ALLOWLIST.has(`${r.method} ${r.url}`))

  assert.deepEqual(
    leaks.map(r => `${r.method} ${r.url}`),
    [],
    'these tenant-scoped routes are public but not in the allowlist — put them behind the secured scope or justify + allowlist them',
  )

  // Guard the guard: every allowlisted route must still exist (so a renamed or
  // deleted receiver can't leave a stale exemption that hides a real leak).
  const present = new Set(collectedRoutes().map(r => `${r.method} ${r.url}`))
  for (const entry of PUBLIC_TENANT_ALLOWLIST) {
    assert.ok(present.has(entry), `allowlist entry no longer exists — prune it: ${entry}`)
  }

  // Spot-check the specific groups this hardening moved.
  const secured = (method: string, url: string) => {
    const r = collectedRoutes().find(x => x.method === method && x.url === url)
    assert.ok(r, `route missing: ${method} ${url}`)
    assert.equal(r!.auth, 'clerk', `${method} ${url} must be Clerk-secured, got '${r!.auth}'`)
  }
  secured('GET', '/api/orgs/:orgId/jira/issues')
  secured('GET', '/api/orgs/:orgId/jira/events')
  secured('GET', '/api/orgs/:orgId/gmail/threads')
  secured('POST', '/api/orgs/:orgId/gmail/send')
  secured('GET', '/api/orgs/:orgId/comms/inbox')
  secured('POST', '/api/orgs/:orgId/meet/create')
  secured('GET', '/api/orgs/:orgId/notifications')
  secured('GET', '/api/agents/:agentId/memory')
  secured('DELETE', '/api/agents/:agentId/memory')
  secured('POST', '/api/orgs/:orgId/webhooks')
  secured('GET', '/api/orgs/:orgId/usage')
  // ONB2 audit H-2 — the two routes this guard used to be blind to. Both are now
  // `:orgId`-scoped, so they are caught by the `tenantScoped` net above and not
  // merely by these spot-checks. (The traces route was `GET /api/traces`, which
  // carried no `:orgId` and so could NEVER be seen by that net — see the re-audit,
  // docs/AUDIT-ONB2-hardening.md.)
  secured('GET', '/api/orgs/:orgId/audit-log')
  secured('GET', '/api/orgs/:orgId/traces')

  // …and the tenant-blind path is gone, not merely shadowed by the new one.
  assert.equal(
    collectedRoutes().find(r => r.url === '/api/traces'), undefined,
    'GET /api/traces is back — a process-wide span buffer with no :orgId cannot be tenant-gated',
  )
})

// ─── Epic ONB — the onboarding surface is shut (audit of ONB1) ───────────────
//
// ONB1 ships the invite OBJECT, not the flow: every invite route is owner-gated
// and the only public onboarding route is the static adapter registry. Two things
// were previously true only by inspection, and are now enforced here:
//
//  1. `PUBLIC_JOIN_IMPLEMENTED` is a hand-maintained constant that holds the join
//     surface shut. A constant promises; a test enforces. While it is false, NO
//     join/claim route may be registered in any scope — so the day someone wires
//     one without flipping the constant (or without ONB3/ONB4's approval gate and
//     rate limit), this fails instead of quietly opening an unauthenticated door.
//  2. The invite routes carry an org-scoped `:orgId`, so the MCA-85 leak guard
//     above already covers them — but only because they are now registered here.
//     They were absent from both guard suites until this audit.
test('[ONB1-audit] the onboarding surface is shut: invites are Clerk-gated, only GET /api/adapters is public', async () => {
  resetOpenApi()
  const app = await bootLikeIndex()
  await app.close()

  const routes = collectedRoutes()
  const find = (method: string, url: string) => routes.find(r => r.method === method && r.url === url)

  for (const [method, url] of [
    ['POST', '/api/orgs/:orgId/agent-invites'],
    ['GET', '/api/orgs/:orgId/agent-invites'],
    ['POST', '/api/orgs/:orgId/agent-invites/:inviteId/revoke'],
    ['GET', '/api/orgs/:orgId/onboarding-posture'],
  ] as const) {
    const r = find(method, url)
    assert.ok(r, `route missing: ${method} ${url}`)
    assert.equal(r!.auth, 'clerk', `${method} ${url} must be Clerk-secured (and owner-gated), got '${r!.auth}'`)
  }

  const registry = find('GET', '/api/adapters')
  assert.ok(registry, 'GET /api/adapters must exist — a joining agent reads the taxonomy before it holds any credential')
  assert.equal(registry!.auth, 'none', 'the adapter registry is public by design: static, org-agnostic, secret-free')

  // The public onboarding surface is an EXPLICIT allowlist, not a pattern. Each
  // entry is public because a joining agent must read it BEFORE it holds any
  // credential — and each mints nothing:
  //   /api/adapters                       static taxonomy, org-agnostic, secret-free (ONB1)
  //   /api/agent-invites/:token/onboarding[.txt]
  //                                       the per-invite document (ONB2). Token-addressed
  //                                       (the invite IS the bearer), profile-gated by
  //                                       `onboardingDocAccess`, and it describes the join/
  //                                       claim endpoints without wiring them. The token is
  //                                       redacted out of the audit log + request log.
  // Anything else public that touches invites/onboarding/join/claim is a leak.
  //   POST /api/agent-invites/:token/join the join request (ONB3). Unauthenticated by
  //                                       design — the invite token is the bearer, and a
  //                                       joining agent has no session to present. Safe
  //                                       because it MINTS NOTHING (it files a row in the
  //                                       owner's approval queue), its exposure follows
  //                                       the deployment profile, it consumes the invite
  //                                       with an atomic CAS, and it is per-IP rate limited.
  // Anything else public that touches invites/onboarding/join/claim is a leak.
  const PUBLIC_ONBOARDING_ALLOWLIST = new Set([
    'GET /api/agent-invites/:token/onboarding',
    'GET /api/agent-invites/:token/onboarding.txt',
    'POST /api/agent-invites/:token/join',
  ])
  const publicOnboarding = routes
    .filter(r => r.auth === 'none' && /agent-invite|onboarding|\/join|\/claim/.test(r.url))
    .map(r => `${r.method} ${r.url}`)
  assert.deepEqual(
    publicOnboarding.filter(r => !PUBLIC_ONBOARDING_ALLOWLIST.has(r)).sort(),
    [],
    'a new public onboarding route appeared — it must be justified and allowlisted here, or moved behind the secured scope',
  )
  for (const entry of PUBLIC_ONBOARDING_ALLOWLIST) {
    assert.ok(publicOnboarding.includes(entry), `allowlisted public onboarding route is missing: ${entry}`)
  }
})

// ─── The landmine guard, ONB3 edition ───────────────────────────────────────
//
// ONB1's version asserted "while PUBLIC_JOIN_IMPLEMENTED is false, no join AND no
// claim route exists". ONB3 builds the join, so that sentence had to change — and
// the honest way to change it is NOT to relax it into "if the constant is true,
// skip the test". The guard is now two directional assertions against two separate
// constants, and it is *stricter* than before, because it now also fails if a route
// goes MISSING while its constant says it exists:
//
//   PUBLIC_JOIN_IMPLEMENTED (true, ONB3)  ⇔ exactly the join route is registered,
//                                           public (the invite token is the bearer).
//   TOKEN_CLAIM_IMPLEMENTED (false, ONB4) ⇔ NO claim route exists, in any scope.
//
// So: wiring a claim endpoint without flipping the constant (and without the hashed,
// single-use, approval-gated claim ONB4 owes) still fails here — which is the whole
// point of the landmine. And "the constant lies" is now a failure in both directions.
test('[ONB3] the join surface exists iff PUBLIC_JOIN_IMPLEMENTED; the claim surface does NOT exist while TOKEN_CLAIM_IMPLEMENTED is false', async () => {
  resetOpenApi()
  const app = await bootLikeIndex()
  await app.close()

  const routes = collectedRoutes()
  const join = routes.filter(r => /^\/api\/agent-invites\/:token\/join$/.test(r.url)).map(r => `${r.method} ${r.url} [${r.auth}]`)

  if (PUBLIC_JOIN_IMPLEMENTED) {
    assert.deepEqual(
      join, ['POST /api/agent-invites/:token/join [none]'],
      'PUBLIC_JOIN_IMPLEMENTED is true, so the public join route must exist exactly once and be token-addressed (auth: none). ' +
      'It is unauthenticated BY DESIGN and safe only because it mints no credential, is posture-gated, consumes the invite atomically, and is per-IP rate limited.',
    )
  } else {
    assert.deepEqual(join, [], 'PUBLIC_JOIN_IMPLEMENTED is false, so no join route may be registered in any scope.')
  }

  // The claim is ONB4 and does not exist. Scoped to the ONBOARDING namespace:
  // `POST /api/agent/tasks/:taskId/claim` is the long-standing agent-token task
  // claim and has nothing to do with onboarding.
  const claimish = routes
    .filter(r => /claim-api-key/.test(r.url) || /^\/api\/agent-invites\/.*\/claim\b/.test(r.url) || /^\/api\/agent-join-requests\//.test(r.url))
    .map(r => `${r.method} ${r.url}`)
  if (!TOKEN_CLAIM_IMPLEMENTED) {
    assert.deepEqual(
      claimish, [],
      'a token-claim route is registered while TOKEN_CLAIM_IMPLEMENTED is false. ONB3 deliberately ships NO credential: an approved ' +
      'agent has a null api_token_hash. Land ONB4 (hashed single-use claimSecret, constant-time compare, CAS, 403-before-approval) and flip the constant in that PR.',
    )
  }
})

// The board-approval gate is the load-bearing control of ONB3, and it is only a gate
// if it is owner-gated. A join request that a member — or an unauthenticated caller —
// could approve would turn "a leaked invite buys a queue item" back into "a leaked
// invite buys an agent".
test('[ONB3] every join-request decision route is Clerk-secured and org-scoped', async () => {
  resetOpenApi()
  const app = await bootLikeIndex()
  await app.close()

  const routes = collectedRoutes()
  for (const [method, url] of [
    ['GET', '/api/orgs/:orgId/agent-join-requests'],
    ['POST', '/api/orgs/:orgId/agent-join-requests/:requestId/approve'],
    ['POST', '/api/orgs/:orgId/agent-join-requests/:requestId/reject'],
  ] as const) {
    const r = routes.find(x => x.method === method && x.url === url)
    assert.ok(r, `route missing: ${method} ${url}`)
    // `:orgId` in the path is not decoration: `requireOrgRole` NO-OPS on a path
    // without one (AUDIT-ONB2-hardening R-4). The owner gate is only real here.
    assert.equal(r!.auth, 'clerk', `${method} ${url} must be Clerk-secured + owner-gated, got '${r!.auth}'`)
  }
})

// AUDIT-ONB3 H-1 — the FOURTH door into the board-approval gate.
//
// `POST /api/approvals/:id/decide` is the route the shipped Inbox/Governance card
// calls, and it funnels an `agent_join_request` decision into `applyJoinDecision` —
// so deciding it CREATES (or refuses) the agent, exactly like the dedicated owner
// routes above. But it looks the approval up BY ID and carries no `:orgId` path param,
// so two guards are blind to it: `requireOrgRole` no-ops without an `:orgId` (R-4), and
// the MCA-85 leak net above only inspects `/:orgId|:agentId/` routes. It must never be
// public, and — the part a route table cannot see — it must enforce membership + the
// type-mapped role (owner for agent-minting) against the org DERIVED FROM THE ROW.
//
// This asserts the visible half (Clerk-secured, single door). The invisible half — a
// non-member is 403, a member is 403 on agent_join_request/agent_create but allowed on
// a lower-stakes card, an owner is allowed on all — is a DRIVEN request against the
// real gate and real DB in `onb3-approval-gate.test.ts` (a route-table assertion cannot
// reach it, which is precisely how H-1 hid).
test('[ONB3-H1] POST /api/approvals/:id/decide is Clerk-secured (membership + type-role enforced in onb3-approval-gate.test.ts)', async () => {
  resetOpenApi()
  const app = await bootLikeIndex()
  await app.close()

  const routes = collectedRoutes()
  const decideRoutes = routes.filter(r => r.url === '/api/approvals/:id/decide')
  assert.deepEqual(
    decideRoutes.map(r => `${r.method} ${r.url} [${r.auth}]`),
    ['POST /api/approvals/:id/decide [clerk]'],
    'the generic approvals decide route must exist exactly once and be Clerk-secured — it is a door into the agent-minting gate, and it has no :orgId for requireOrgRole/the leak net to catch, so it must never be public',
  )
})

test('[MCA-85] secured scope enforces 401; public webhook receiver is not gated', async () => {
  const app = Fastify({ logger: false })
  // Real Clerk hook, but with a verifier that always rejects — stands in for an
  // invalid/absent session without reaching Clerk's network JWKS.
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async () => { throw new Error('no session') }))
    await secured.register(jiraRoutes)
    await secured.register(skillRoutes)
  })
  await app.register(commsWebhookRoutes)
  await app.ready()

  // Moved route, no Authorization header → 401 before the handler runs.
  const noAuth = await app.inject({ method: 'GET', url: '/api/orgs/o1/jira/status' })
  assert.equal(noAuth.statusCode, 401, 'jira status must reject unauthenticated callers')

  // Moved route, garbage token → verifier throws → 401.
  const badToken = await app.inject({
    method: 'GET', url: '/api/skills',
    headers: { authorization: 'Bearer not.a.jwt' },
  })
  assert.equal(badToken.statusCode, 401, 'skills must reject an invalid token')

  // Public receiver: an empty Telegram update short-circuits before any DB call,
  // so a 200 here proves it is reachable with no session (not auth-gated).
  const receiver = await app.inject({
    method: 'POST', url: '/api/telegram/webhook/o1',
    payload: {}, headers: { 'content-type': 'application/json' },
  })
  assert.equal(receiver.statusCode, 200, 'telegram webhook receiver must stay public')
  assert.deepEqual(receiver.json(), { ok: true })

  await app.close()
})
