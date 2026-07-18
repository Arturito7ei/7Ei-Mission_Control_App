// Epic CONN / CONN-8a — the connector EXECUTION FRAMEWORK.
//
// This is the harness that lets an agent ACTUALLY invoke a connector action against a
// real provider with a real credential — the highest-consequence stage of the epic.
// Every path is fail-CLOSED and gated by CONN-7's authorization. There is ONE entry
// point, `executeConnectorAction`, and it enforces, in order:
//
//   1. TENANT + AGENT scope: the agent must exist and belong to `orgId` (never
//      cross-tenant). The connector must be a known, configured (not disabled) one.
//   2. EXPLICIT capability (CONN-7 carry-forward i): execution requires an EXPLICIT
//      `connector:<id>` / `connector:*` / `*` capability. Unlike CONN-7's authz, an
//      empty/legacy allow-all permission list does NOT grant execution — the whole
//      point of the tightening is that "an agent with no permissions" can no longer
//      make real external calls just because the legacy default is allow-all.
//   3. The CONN-7 DECISION (`decideConnectorAuthorization`): READ → allow, WRITE →
//      allow only if the (agent,connector) is trusted (`auto_write`), DESTRUCTIVE /
//      UNKNOWN → always needs approval. Plus carry-forward (ii): an OPAQUE tool the
//      executor does not recognize (MCP's open-ended surface) is escalated to
//      needs_approval EVEN under auto_write.
//   4. On `needs_approval` → NOT executed. A dangerous `connector_action` approval is
//      filed (the SAME step-up + machine-rendered card the Inbox uses) and the caller
//      gets a pending result referencing the approvalId. The agent must wait for the
//      operator to approve (with step-up) before it can execute.
//   5. On `allow` → execute exactly once, recording an audit row.
//   6. REDEEMING an approval: when the caller supplies an `approvalId`, the action
//      executes ONLY if that approval is `connector_action`, in the org, bound to this
//      exact (agent, connector, action), and in the `approved` state (which the decide
//      route only reaches after step-up). Execution is SINGLE-USE: the redemption is
//      claimed atomically via a UNIQUE index on `connector_executions.approval_id`, so
//      a replay (or two concurrent redemptions) is rejected — the action runs at most
//      once per approval.
//
// The credential is decrypted ONLY at execution time, handed to the executor for the
// provider call, and NEVER logged, NEVER returned, NEVER stored. A redaction pass over
// the result + errors is the belt-and-suspenders backstop.

import { randomUUID } from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { decrypt, resolveSecretsForAgent, AGENT_RESOLVABLE_SCOPES } from './secrets'
import { parseCapabilities, isCapabilityAllowed } from './governance2'
import {
  getAgentConnector, normalizeTrustLevel, connectorEnvKeys, type TrustLevel,
} from './agent-connectors'
import {
  classifyConnectorAction, decideConnectorAuthorization, connectorCapability,
  fileConnectorActionApproval, connectorParamsDigest, type ConnectorActionClass,
} from './connector-authz'
import { githubExecutor } from './connector-github'
import { jiraExecutor } from './connector-jira'
import { telegramExecutor } from './connector-telegram'
import { whatsappExecutor } from './connector-whatsapp'
import { googleChatExecutor } from './connector-google-chat'
import { googleExecutor } from './connector-google'
import { ensureFreshAgentGoogleToken } from './agent-google-auth'

// ─── HTTP transport (bounded, injectable for tests) ──────────────────────────

export interface HttpResponse {
  status: number
  ok: boolean
  json(): Promise<any>
  text(): Promise<string>
}

/** The transport an executor uses. Injectable so tests never touch the network. The
 *  DEFAULT (`boundedHttpClient`) enforces a hard timeout + a response-size cap. An
 *  executor is responsible for SSRF safety by building URLs against a HARDCODED host
 *  (see connector-github.ts) — this client never widens that. */
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>

export const EXECUTION_TIMEOUT_MS = 10_000
export const MAX_RESPONSE_BYTES = 1_000_000 // 1 MB — a connector read is metadata, not a firehose

/** A provider (or transport) failure the framework turns into a CLEAN structured error —
 *  never a raw provider body that might carry a secret. */
export class ConnectorProviderError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ConnectorProviderError'
    this.status = status
  }
}

/** The real transport: global fetch + AbortController timeout + a response-size cap.
 *  Kept tiny and dependency-free. */
export const boundedHttpClient: HttpClient = async (url, init) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS)
  let res: Response
  try {
    // redirect:'error' (audit N2): a provider 3xx must NOT be silently followed —
    // a redirect is the classic way to bounce a fixed-host call off to another host.
    res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, redirect: 'error', signal: controller.signal })
  } catch (e: any) {
    clearTimeout(timer)
    if (e?.name === 'AbortError') throw new ConnectorProviderError(`provider request timed out after ${EXECUTION_TIMEOUT_MS}ms`)
    throw new ConnectorProviderError('provider request failed')
  }
  clearTimeout(timer)
  // Enforce the size cap up front when the provider is honest about content-length…
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ConnectorProviderError(`provider response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }
  // …and again on the materialized body (a lying/absent content-length can't bypass it).
  const bodyText = await res.text()
  if (bodyText.length > MAX_RESPONSE_BYTES) {
    throw new ConnectorProviderError(`provider response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }
  return {
    status: res.status,
    ok: res.ok,
    text: async () => bodyText,
    json: async () => { try { return JSON.parse(bodyText) } catch { return null } },
  }
}

// ─── The executor contract ────────────────────────────────────────────────────

export interface ExecutorContext {
  params: Record<string, unknown>
  /** ONLY this connector's env keys, decrypted (for `credentialKind:'env'` connectors).
   *  Used for the provider call; the framework never returns/logs it. Empty for an
   *  OAuth connector (whose credential arrives via `oauthAccessToken`). */
  secrets: Record<string, string>
  http: HttpClient
  /** The agent's FRESH OAuth access token — present ONLY for a `credentialKind:'google_oauth'`
   *  connector, resolved by the framework via CONN-5's `ensureFreshAgentGoogleToken`
   *  (decrypt → refresh-if-stale → re-encrypt in place). Used ONLY as a Bearer to the
   *  executor's HARDCODED provider host; the framework registers it for the redaction
   *  backstop so it can never leak through a result/error. The refresh token never
   *  reaches an executor at all. */
  oauthAccessToken?: string
  /** The GRANTED OAuth scope string (space-separated) for the connection, so an OAuth
   *  executor can pre-check an action's required scope and fail closed with a clean
   *  "reconnect with X" instead of dialing a call that a raw Google 403 would reject. */
  oauthScopes?: string | null
}

export interface ConnectorActionSpec {
  /** MUST equal `classifyConnectorAction(connectorId, action)` — asserted in tests so
   *  an executor can never drift from CONN-7's taxonomy. */
  class: ConnectorActionClass
  handler: (ctx: ExecutorContext) => Promise<unknown>
}

export interface ConnectorExecutor {
  connectorId: string
  actions: Record<string, ConnectorActionSpec>
  /** How the framework resolves this connector's credential at execution time:
   *   • 'env' (default)        → decrypt ONLY this connector's env keys → `ctx.secrets`
   *                              (github/jira/comms — the secret-bag connectors).
   *   • 'google_oauth'         → resolve the agent's fresh Google OAuth access token via
   *                              CONN-5 `ensureFreshAgentGoogleToken` → `ctx.oauthAccessToken`
   *                              (+ `ctx.oauthScopes`). NEVER touches the env secret bag.
   *                              A missing/revoked connection fails CLOSED (no execute). */
  credentialKind?: 'env' | 'google_oauth'
  /** Does this executor recognize the action as a KNOWN, implemented one? Defaults to
   *  membership in `actions`. An open-ended connector (MCP) overrides this so an opaque
   *  tool the executor can't vouch for is treated as unknown → escalated to approval
   *  even under auto_write (CONN-7 carry-forward ii). */
  knowsAction?(action: string): boolean
}

/** Resolve the agent's fresh Google OAuth access token (+ granted scopes). Injectable
 *  so tests never touch Google; defaults to CONN-5's `ensureFreshAgentGoogleToken`.
 *  Returns null when the agent has no usable Google connection (never connected, or
 *  revoked / refresh failed) → the framework fails CLOSED. */
export type GoogleTokenResolver = (
  orgId: string,
  agentId: string,
) => Promise<{ accessToken: string; accountEmail: string | null; scopes: string | null } | null>

/** The connectors that can ACTUALLY execute. CONN-8a shipped GitHub; CONN-8b-1 added the
 *  Jira + comms (Telegram / WhatsApp / Google Chat) executors; CONN-8b-2 adds Google
 *  Workspace (Gmail / Calendar / Drive) — the first OAUTH-credentialed executor, which
 *  resolves its credential from CONN-5's encrypted `agent_oauth_tokens`, not the env
 *  secret bag. Only the MCP bridge still has NO executor and therefore CANNOT execute — a
 *  fail-closed default, not an oversight (CONN-8b-3 adds it). */
export const EXECUTORS: Record<string, ConnectorExecutor> = {
  github: githubExecutor,
  jira: jiraExecutor,
  telegram: telegramExecutor,
  whatsapp: whatsappExecutor,
  google_chat: googleChatExecutor,
  google: googleExecutor,
}

export function getExecutor(connectorId: string): ConnectorExecutor | undefined {
  return EXECUTORS[connectorId]
}

function executorKnowsAction(executor: ConnectorExecutor, action: string): boolean {
  if (executor.knowsAction) return executor.knowsAction(action)
  // Object.hasOwn, not `in` (audit N3): never resolve a prototype-chain key like
  // `constructor`/`toString` to a bogus "known action".
  return Object.hasOwn(executor.actions, action)
}

// ─── The explicit-capability tightening (CONN-7 carry-forward i) ───────────────

/**
 * Execution requires an EXPLICIT connector capability. Stricter than CONN-7's
 * `hasConnectorCapability` (which, via `isCapabilityAllowed`, treats an empty/absent
 * permission list as allow-all): here an empty/legacy allow-all list grants NOTHING.
 * An explicit `connector:<id>`, `connector:*`, or the global `*` still satisfies it —
 * only the "no permissions declared → allowed by default" case is closed.
 */
export function hasExplicitConnectorCapability(
  permissions: string[] | null | undefined,
  connectorId: string,
): boolean {
  if (!permissions || permissions.length === 0) return false // the tightening: no implicit allow-all
  return isCapabilityAllowed(permissions, connectorCapability(connectorId))
}

/**
 * Carry-forward (ii): should an otherwise-allowed WRITE be escalated to needs_approval
 * because the executor cannot vouch for the action? Only bites open-ended surfaces
 * (MCP), where an unknown tool is opaque — a fixed-surface executor (GitHub) knows all
 * of its write actions, so its writes are unaffected. Pure.
 */
export function mustEscalateUnknownWrite(
  executor: ConnectorExecutor,
  classification: ConnectorActionClass,
  action: string,
): boolean {
  return classification === 'write' && !executorKnowsAction(executor, action)
}

// ─── Credential resolution (execution-time only) ──────────────────────────────

/** Resolve + decrypt ONLY this connector's env keys for this agent. Company scope
 *  first, then agent-scope overrides (mirrors `GET /api/agent/secrets`). Never widened
 *  to the whole bag — the executor sees only what it needs. */
async function resolveConnectorSecrets(orgId: string, agentId: string, connectorId: string): Promise<Record<string, string>> {
  const wanted = connectorEnvKeys(connectorId)
  if (wanted.length === 0) return {}
  const rows = await db.select().from(schema.secrets).where(and(
    eq(schema.secrets.orgId, orgId),
    inArray(schema.secrets.scope, [...AGENT_RESOLVABLE_SCOPES]),
  ))
  const decrypted = rows
    .map(s => { try { return { scope: s.scope, scopeId: s.scopeId, key: s.key, value: decrypt(s.valueEncrypted) } } catch { return null } })
    .filter(Boolean) as any[]
  const bag = resolveSecretsForAgent(decrypted, agentId)
  const out: Record<string, string> = {}
  for (const k of wanted) if (bag[k] != null) out[k] = bag[k]
  return out
}

// ─── Redaction backstop (belt-and-suspenders) ─────────────────────────────────

function redactString(s: string, secretValues: string[]): string {
  let out = s
  for (const v of secretValues) if (v && out.includes(v)) out = out.split(v).join('«redacted»')
  return out
}

/** Deep-replace any occurrence of a credential VALUE in a result/error with a
 *  placeholder. The provider payloads we return should never contain our token, but a
 *  buggy/hostile provider echoing it must not leak it to the agent. */
export function redactSecrets<T>(value: T, secretValues: string[]): T {
  const vals = secretValues.filter(v => typeof v === 'string' && v.length > 0)
  if (vals.length === 0) return value
  const walk = (v: any): any => {
    if (typeof v === 'string') return redactString(v, vals)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) o[k] = walk(val)
      return o
    }
    return v
  }
  return walk(value)
}

// ─── The result type ───────────────────────────────────────────────────────────

export type ConnectorExecutionResult =
  | { status: 'executed'; connectorId: string; action: string; classification: ConnectorActionClass; executionId: string; data: unknown }
  | { status: 'pending_approval'; connectorId: string; action: string; classification: ConnectorActionClass; approvalId: string; reason: string }
  | { status: 'denied'; reason: string; classification: ConnectorActionClass }
  | { status: 'rejected'; reason: string; classification: ConnectorActionClass }
  | { status: 'error'; reason: string; classification: ConnectorActionClass }

export interface ExecuteConnectorActionInput {
  orgId: string
  agentId: string
  connectorId: string
  action: string
  params?: Record<string, unknown>
  /** Non-secret label for the approval card. NEVER a credential. */
  target?: string | null
  /** Set to REDEEM a previously-approved gated action. Absent = a first-pass request. */
  approvalId?: string | null
}

export interface ExecuteOptions {
  /** Injectable transport (tests). Defaults to the bounded real client. */
  httpClient?: HttpClient
  /** Injectable Google OAuth token resolver (tests). Defaults to CONN-5's
   *  `ensureFreshAgentGoogleToken`. Only consulted for a `google_oauth` connector. */
  googleTokenResolver?: GoogleTokenResolver
}

// ─── The single entry point ─────────────────────────────────────────────────

export async function executeConnectorAction(
  input: ExecuteConnectorActionInput,
  opts: ExecuteOptions = {},
): Promise<ConnectorExecutionResult> {
  const { orgId, agentId, connectorId } = input
  const action = String(input.action ?? '').trim()
  const params = input.params ?? {}
  const http = opts.httpClient ?? boundedHttpClient
  const googleTokenResolver = opts.googleTokenResolver ?? ensureFreshAgentGoogleToken
  const classification = classifyConnectorAction(connectorId, action)

  // 1. Tenant + agent scope — fail closed on a missing / cross-tenant agent.
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  if (!agent || agent.orgId !== orgId) {
    return { status: 'denied', reason: 'agent not found in org', classification }
  }
  const meta = getAgentConnector(connectorId)
  if (!meta) return { status: 'denied', reason: 'unknown connector', classification }
  if (!action) return { status: 'rejected', reason: 'action is required', classification }

  // The connector row (config + trust). Configured = a row that isn't disabled.
  const row = await db.query.agentConnectors.findFirst({
    where: and(
      eq(schema.agentConnectors.orgId, orgId),
      eq(schema.agentConnectors.agentId, agentId),
      eq(schema.agentConnectors.connectorId, connectorId),
    ),
  })
  const connectorConfigured = !!row && row.status !== 'disabled' && row.status !== 'not_configured'
  const trustLevel: TrustLevel = normalizeTrustLevel(row?.trustLevel)

  // 2. Explicit capability (carry-forward i) — before ANYTHING else executes.
  const permissions = parseCapabilities(agent.permissions)
  if (!hasExplicitConnectorCapability(permissions, connectorId)) {
    return { status: 'denied', reason: 'agent lacks an explicit connector capability (execution requires connector:<id>, connector:*, or *)', classification }
  }
  if (!connectorConfigured) {
    return { status: 'denied', reason: 'connector is not configured for this agent', classification }
  }

  // 3. There must be a real executor for this connector, or nothing runs (fail-closed:
  //    jira/google/comms/mcp have none in 8a).
  const executor = getExecutor(connectorId)
  if (!executor) {
    return { status: 'rejected', reason: `no executor available for connector '${connectorId}' (execution not supported yet)`, classification }
  }

  // ─── Redemption path: caller supplied an approvalId ──────────────────────────
  if (input.approvalId) {
    return redeemAndExecute({ orgId, agentId, connectorId, action, params, classification, approvalId: input.approvalId, executor, http, googleTokenResolver })
  }

  // ─── First-pass path: derive the decision (tightened cap + MCP escalation) ───
  let decision = decideConnectorAuthorization({ hasCapability: true, connectorConfigured, classification, trustLevel }).decision
  if (decision === 'allow' && mustEscalateUnknownWrite(executor, classification, action)) {
    decision = 'needs_approval' // carry-forward ii: opaque tool never auto-executes
  }

  if (decision === 'deny') {
    return { status: 'denied', reason: 'authorization denied', classification }
  }
  if (decision === 'needs_approval') {
    const filed = await fileConnectorActionApproval({
      orgId, agentId, connectorId, connectorName: meta.name, action, classification, target: input.target ?? null,
      // NIT-1: bind the approval to THESE exact params (server-computed digest + a card
      // target derived from them) so the approved params ARE the executed params.
      params,
    })
    if (!filed.ok) return { status: 'rejected', reason: `could not file approval: ${filed.error}`, classification }
    return { status: 'pending_approval', connectorId, action, classification, approvalId: filed.approvalId!, reason: 'action requires operator approval (with step-up) before it can execute' }
  }

  // allow → execute exactly once (allow-path rows carry a NULL approvalId).
  return runExecutor({ orgId, agentId, connectorId, action, params, classification, approvalId: null, executor, http, googleTokenResolver })
}

// ─── Redeem an approved gated action, then execute exactly once ────────────────

async function redeemAndExecute(args: {
  orgId: string; agentId: string; connectorId: string; action: string
  params: Record<string, unknown>; classification: ConnectorActionClass
  approvalId: string; executor: ConnectorExecutor; http: HttpClient
  googleTokenResolver: GoogleTokenResolver
}): Promise<ConnectorExecutionResult> {
  const { orgId, agentId, connectorId, action, classification, approvalId } = args
  const approval = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, approvalId) })
  if (!approval || approval.orgId !== orgId || approval.type !== 'connector_action') {
    return { status: 'rejected', reason: 'approval not found for this connector action', classification }
  }
  // Execution requires the approval to be in the APPROVED state — which the decide route
  // only reaches AFTER step-up. A pending/rejected/revision approval never executes.
  if (approval.status !== 'approved') {
    return { status: 'rejected', reason: `approval is not in the approved state (status: ${approval.status})`, classification }
  }
  // Bind the approval to THIS exact action + agent, so an approval for X can't run Y,
  // and agent A can't redeem agent B's approval.
  const pa = (approval.payload as any)?.action ?? {}
  if (pa.connectorId !== connectorId || String(pa.action) !== action || pa.agentId !== agentId) {
    return { status: 'rejected', reason: 'approval does not match this action', classification }
  }
  // NIT-1: bind the PARAMS too — the executed params MUST equal the approved params. The
  // stored digest was computed server-side at file time; recompute from the params the
  // agent submits now and require a match, so an approved "send to bob" can't be redeemed
  // to "send to eve". A missing/legacy digest (never bound) also fails closed here.
  const expectedDigest = connectorParamsDigest(args.params)
  if (typeof pa.paramsDigest !== 'string' || pa.paramsDigest !== expectedDigest) {
    return { status: 'rejected', reason: 'approval does not match this action (params changed since approval)', classification }
  }
  return runExecutor({ ...args, approvalId })
}

// ─── The claim-then-execute core (single-use + credential handling) ────────────

async function runExecutor(args: {
  orgId: string; agentId: string; connectorId: string; action: string
  params: Record<string, unknown>; classification: ConnectorActionClass
  approvalId: string | null; executor: ConnectorExecutor; http: HttpClient
  googleTokenResolver: GoogleTokenResolver
}): Promise<ConnectorExecutionResult> {
  const { orgId, agentId, connectorId, action, params, classification, approvalId, executor, http, googleTokenResolver } = args

  // Object.hasOwn (audit N3): a prototype key like `constructor` must not resolve to a
  // truthy-but-bogus spec.
  const spec = Object.hasOwn(executor.actions, action) ? executor.actions[action] : undefined
  if (!spec) {
    return { status: 'rejected', reason: `executor does not implement action '${action}'`, classification }
  }

  // CLAIM first (before any provider call). For a gated redemption this is the
  // single-use guarantee: the UNIQUE index on approval_id makes a second insert with
  // the same approvalId throw → replay rejected. For the allow-path (approvalId=null)
  // the row is audit-only (many NULLs allowed). Claiming BEFORE the call means even a
  // failed provider call consumes the approval — at-most-once, never a replay.
  const executionId = randomUUID()
  try {
    await db.insert(schema.connectorExecutions).values({
      id: executionId, orgId, agentId, connectorId, action, classification,
      approvalId: approvalId ?? null, status: 'running', error: null, createdAt: new Date(),
    } as any)
  } catch {
    // Only a UNIQUE(approval_id) collision lands here (a real replay); a NULL approvalId
    // can't collide. Treat any insert failure as a fail-closed replay rejection.
    return { status: 'rejected', reason: 'this approval has already been executed (single-use)', classification }
  }

  // Resolve the credential ONLY now, per the executor's credential kind, and hand the
  // executor ONLY what it needs. `secretValues` feeds the redaction backstop — it MUST
  // include the OAuth access token so a buggy/hostile provider that echoes it can't leak
  // it through the result/error.
  const ctx: ExecutorContext = { params, secrets: {}, http }
  const secretValues: string[] = []

  if (executor.credentialKind === 'google_oauth') {
    // OAuth connector: obtain a FRESH access token from CONN-5's encrypted agent token
    // store (decrypt → refresh-if-stale → re-encrypt). NEVER the env secret bag. A
    // missing / revoked connection (resolver → null or throw) fails CLOSED: the action
    // does NOT execute; the operator must (re)connect Google for this agent.
    let resolved: Awaited<ReturnType<GoogleTokenResolver>> = null
    try {
      resolved = await googleTokenResolver(orgId, agentId)
    } catch {
      resolved = null // a refresh/network error is treated as "not connected" → fail closed
    }
    if (!resolved || !resolved.accessToken) {
      const reason = 'google connection is unavailable — (re)connect the agent\'s Google account'
      await db.update(schema.connectorExecutions).set({ status: 'failed', error: reason }).where(eq(schema.connectorExecutions.id, executionId))
      return { status: 'error', reason, classification }
    }
    ctx.oauthAccessToken = resolved.accessToken
    ctx.oauthScopes = resolved.scopes ?? null
    secretValues.push(resolved.accessToken)
  } else {
    // env connector (github/jira/comms): decrypt ONLY this connector's env keys.
    const secrets = await resolveConnectorSecrets(orgId, agentId, connectorId)
    ctx.secrets = secrets
    secretValues.push(...Object.values(secrets))
  }

  try {
    const raw = await spec.handler(ctx)
    const data = redactSecrets(raw, secretValues) // backstop: strip any echoed credential
    await db.update(schema.connectorExecutions).set({ status: 'succeeded' }).where(eq(schema.connectorExecutions.id, executionId))
    return { status: 'executed', connectorId, action, classification, executionId, data }
  } catch (e: any) {
    // Clean, sanitized error — never a raw provider body, never the credential.
    const base = e instanceof ConnectorProviderError ? e.message : 'connector action failed'
    const reason = redactString(String(base), secretValues)
    await db.update(schema.connectorExecutions).set({ status: 'failed', error: reason }).where(eq(schema.connectorExecutions.id, executionId))
    return { status: 'error', reason, classification }
  }
}
