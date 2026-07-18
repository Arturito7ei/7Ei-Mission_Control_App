// Epic CONN / CONN-7 — the connector CONTAINMENT / trust + approval layer.
//
// This is the policy that CONN-8 (the execution bridge) MUST consult before running
// ANY connector action. CONN-7 itself does NOT execute connectors — it only DEFINES
// and ENFORCES the decision. The confirmed, operator-approved model:
//
//   • READ actions run FREELY.
//   • WRITE / SEND actions need APPROVAL by default (via the EXISTING dangerous-action
//     approval + step-up flow), UNLESS the (agent, connector) pair is TRUSTED
//     (trustLevel = 'auto_write'), in which case a WRITE is auto-approved.
//   • DESTRUCTIVE actions ALWAYS need approval — even for a trusted connector.
//   • An agent must hold the `connector:<id>` capability (or `connector:*` / `*`) to
//     use a connector at all. Absent capability → DENY.
//   • A connector that isn't configured for the agent → DENY.
//
// Fail-CLOSED everywhere: an unknown action, an unknown connector, a missing agent,
// or any ambiguity resolves to `needs_approval` or `deny` — NEVER a silent `allow`.
//
// The three pure pieces (taxonomy → classify → decide) are unit-testable with no IO;
// `authorizeConnectorAction` is the one IO entry point CONN-8 calls, and it routes a
// `needs_approval` through the SAME `approval_requests` + step-up path the Inbox uses.

import { randomUUID, createHash } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { getAgentConnector, normalizeTrustLevel, type TrustLevel } from './agent-connectors'
import { isCapabilityAllowed, parseCapabilities } from './governance2'
import { prepareApprovalRecord } from './dangerous-approvals'
import { notifyApprovalCreated } from './push'

// ─── 1. The connector action TAXONOMY (the data map CONN-8 consults) ───────────
//
// Per connector, a classification of the actions it could perform into READ (safe),
// WRITE/SEND (approval unless trusted) and DESTRUCTIVE (approval always). `defaultClass`
// is the verdict for an action NOT in any explicit set:
//   • mcp → 'write'   (a custom MCP tool call is treated as WRITE by default — the
//                      unknown tool still needs approval unless the server is trusted).
//   • everyone else → 'unknown' (a verb we don't recognize on a known provider is
//                      failed CLOSED — it needs approval EVEN when trusted).
// Action strings are matched case-insensitively; both dotted (`issue.delete`) and
// snake (`delete_issue`) spellings are covered so a caller's vocabulary variations
// land on the right class. A DESTRUCTIVE-keyword guard (below) is the backstop.

export type ConnectorActionClass = 'read' | 'write' | 'destructive' | 'unknown'

interface ConnectorActionMap {
  read: readonly string[]
  write: readonly string[]
  destructive: readonly string[]
  defaultClass: ConnectorActionClass
}

export const CONNECTOR_ACTION_TAXONOMY: Record<string, ConnectorActionMap> = {
  github: {
    read: ['read', 'get', 'list', 'search', 'clone', 'fetch', 'repo.read', 'issue.read', 'issues.read',
      'pr.read', 'pulls.read', 'get_issue', 'list_issues', 'get_repo', 'get_pull_request', 'get_file_contents'],
    write: ['create', 'update', 'edit', 'comment', 'push', 'commit', 'merge', 'issue.create', 'issue.comment',
      'issues.create', 'pr.create', 'pulls.create', 'create_issue', 'add_comment', 'create_pull_request',
      'update_issue', 'create_or_update_file', 'add_labels'],
    destructive: ['delete', 'force_push', 'force-push', 'repo.delete', 'branch.delete', 'delete_repo',
      'delete_branch', 'delete_file', 'delete_issue'],
    defaultClass: 'unknown',
  },
  jira: {
    read: ['read', 'get', 'list', 'search', 'jql', 'issue.read', 'get_issue', 'list_issues', 'search_issues'],
    write: ['create', 'update', 'edit', 'comment', 'transition', 'assign', 'issue.create', 'issue.transition',
      'create_issue', 'add_comment', 'transition_issue', 'update_issue'],
    destructive: ['delete', 'issue.delete', 'delete_issue'],
    defaultClass: 'unknown',
  },
  google: {
    // One Google connection covers Gmail / Calendar / Drive; classify across all three.
    read: ['read', 'get', 'list', 'search', 'download', 'list_messages', 'get_message', 'list_events',
      'get_event', 'list_files', 'get_file'],
    write: ['send', 'send_message', 'create', 'update', 'insert', 'modify', 'reply', 'forward', 'share',
      'create_event', 'update_event', 'upload', 'write', 'create_file', 'update_file'],
    destructive: ['delete', 'trash', 'empty_trash', 'permanently_delete', 'delete_message', 'delete_event',
      'delete_file'],
    defaultClass: 'unknown',
  },
  telegram: {
    read: ['read', 'get', 'get_updates', 'get_chat'],
    write: ['send', 'send_message', 'message', 'post', 'reply', 'send_photo', 'send_document'],
    destructive: ['delete', 'delete_message', 'delete_chat'],
    // A comms connector's whole purpose is sending — an unrecognized action is treated
    // as a WRITE (needs approval unless trusted), consistent with send=WRITE.
    defaultClass: 'write',
  },
  whatsapp: {
    read: ['read', 'get', 'get_message'],
    write: ['send', 'send_message', 'message', 'post', 'reply', 'send_template'],
    destructive: ['delete', 'delete_message'],
    defaultClass: 'write',
  },
  google_chat: {
    read: ['read', 'get', 'get_message', 'list_messages'],
    write: ['send', 'send_message', 'message', 'post', 'create_message', 'reply'],
    destructive: ['delete', 'delete_message'],
    defaultClass: 'write',
  },
  mcp: {
    // A custom MCP tool call is a WRITE by default — we can't know a third-party
    // tool's effect, so err on the side of approval (auto-approved only when trusted).
    read: [],
    write: [],
    destructive: [],
    defaultClass: 'write',
  },
}

// A verb that LOOKS destructive is forced to 'destructive' even if it isn't in the
// explicit set — a trusted connector must never auto-approve a stray "delete_*"/"purge".
const DESTRUCTIVE_VERBS = ['delete', 'destroy', 'drop', 'purge', 'remove', 'wipe', 'revoke', 'truncate'] as const
const DESTRUCTIVE_SET = new Set<string>(DESTRUCTIVE_VERBS)

/**
 * Does this action contain a destructive VERB as a whole token? Fail-closed backstop:
 * a trusted connector must never auto-approve a destructive action just because its
 * verb wasn't in the explicit set. Tokenizes across BOTH separators (`.` `_` `:` `-`
 * space) AND camelCase boundaries, so `delete_file`, `deleteFile`, `forceDelete`,
 * `dropTable` and `purgeAll` all surface their destructive verb — the separator-only
 * regex this replaces missed every camelCase / concatenated spelling, letting e.g.
 * `deleteFile` on a trusted `auto_write` connector classify as WRITE and auto-approve.
 * Token-level (not substring) so benign words that merely CONTAIN a verb — `undelete`,
 * `backdrop`, `dropdown`, `get_deleted_items` — are NOT swept up (over-approval only
 * on genuine destructive verbs). Matches the ORIGINAL casing to see camelCase.
 */
function hasDestructiveVerb(rawAction: string): boolean {
  const tokens = rawAction
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase: deleteFile → "delete File"
    .split(/[._:\-\s]+/)
    .map(t => t.toLowerCase())
    .filter(Boolean)
  return tokens.some(t => DESTRUCTIVE_SET.has(t) || DESTRUCTIVE_SET.has(t.replace(/s$/, '')))
}

const WRITE_KEYWORD = /(^|[._:\- ])(send|create|update|write|push|commit|comment|post|edit|modify|upload|insert|merge|transition|reply|forward|share|add)([._:\- ]|$)/
const READ_KEYWORD = /(^|[._:\- ])(read|get|list|search|fetch|view|download|show)([._:\- ]|$)/

/**
 * Classify a connector action into read / write / destructive / unknown. Pure and
 * deterministic. Precedence: an EXPLICIT taxonomy hit wins; then a destructive
 * KEYWORD (the fail-closed backstop); then write / read keywords; then the
 * connector's `defaultClass`. An unknown connector or a blank action → 'unknown'.
 */
export function classifyConnectorAction(connectorId: string, action: unknown): ConnectorActionClass {
  const raw = String(action ?? '').trim()
  const norm = raw.toLowerCase()
  const map = CONNECTOR_ACTION_TAXONOMY[connectorId]
  if (!map) return 'unknown'          // unknown connector → fail closed
  if (!norm) return 'unknown'         // no action given → fail closed
  if (map.destructive.includes(norm)) return 'destructive'
  if (map.read.includes(norm)) return 'read'
  if (map.write.includes(norm)) return 'write'
  if (hasDestructiveVerb(raw)) return 'destructive' // camelCase/sep-aware fail-closed backstop
  if (WRITE_KEYWORD.test(norm)) return 'write'
  if (READ_KEYWORD.test(norm)) return 'read'
  return map.defaultClass
}

// ─── 2. Capability grammar — the reserved `connector:` namespace, now ENFORCED ─

/** The capability an agent must hold to use a connector at all: `connector:<id>`.
 *  `connector:*` and the global `*` also satisfy it (see isCapabilityAllowed). */
export function connectorCapability(connectorId: string): string {
  return `connector:${connectorId}`
}

/** Does the agent's permission list grant use of this connector? */
export function hasConnectorCapability(permissions: string[] | null | undefined, connectorId: string): boolean {
  return isCapabilityAllowed(permissions, connectorCapability(connectorId))
}

// ─── 3. The pure DECISION ──────────────────────────────────────────────────────

export type AuthorizationDecision = 'allow' | 'needs_approval' | 'deny'

export interface AuthorizationResult {
  decision: AuthorizationDecision
  reason: string
  classification: ConnectorActionClass
}

/**
 * The core fail-closed decision, given the already-resolved facts. Pure:
 *   missing capability          → deny
 *   connector not configured    → deny
 *   READ                        → allow
 *   WRITE + auto_write          → allow
 *   WRITE + approval_required   → needs_approval
 *   DESTRUCTIVE                 → needs_approval  (ALWAYS — trust is ignored)
 *   UNKNOWN                     → needs_approval  (fail-closed — trust is ignored)
 */
export function decideConnectorAuthorization(input: {
  hasCapability: boolean
  connectorConfigured: boolean
  classification: ConnectorActionClass
  trustLevel: TrustLevel
}): AuthorizationResult {
  const { classification } = input
  if (!input.hasCapability) {
    return { decision: 'deny', reason: 'agent lacks the connector capability', classification }
  }
  if (!input.connectorConfigured) {
    return { decision: 'deny', reason: 'connector is not configured for this agent', classification }
  }
  if (classification === 'read') {
    return { decision: 'allow', reason: 'read actions run freely', classification }
  }
  if (classification === 'destructive') {
    return { decision: 'needs_approval', reason: 'destructive actions always require approval', classification }
  }
  if (classification === 'unknown') {
    return { decision: 'needs_approval', reason: 'unrecognized action — approval required (fail-closed)', classification }
  }
  // WRITE
  if (input.trustLevel === 'auto_write') {
    return { decision: 'allow', reason: 'write auto-approved for a trusted connector', classification }
  }
  return { decision: 'needs_approval', reason: 'write actions require approval', classification }
}

// ─── 4. The IO enforcement entry point (what CONN-8 will call) ─────────────────

export interface AuthorizeConnectorActionInput {
  orgId: string
  agentId: string
  connectorId: string
  /** The action verb the runtime wants to perform (e.g. 'issue.create', 'send', a
   *  custom MCP tool name). Classified against CONNECTOR_ACTION_TAXONOMY. */
  action: string
  /** Optional non-secret context for the approval card (a target label + a summary).
   *  NEVER pass a credential here — it would land in the approval payload. */
  target?: string | null
  summary?: string | null
}

export interface AuthorizeConnectorActionResult extends AuthorizationResult {
  /** Set when `decision === 'needs_approval'` — the pending approval_requests id the
   *  operator will act on (routed through the existing Inbox + step-up gate). */
  approvalId?: string
}

/**
 * Resolve + apply the connector authorization policy for one action, and — when the
 * verdict is `needs_approval` — file an `approval_requests` row of the dangerous type
 * `connector_action`, so it appears in the operator's Inbox and requires the SAME
 * step-up (`x-arturita-session` fresh session) to approve that the phone/desk enforce.
 *
 * CONN-7 does NOT execute the action. CONN-8 must call this first and only proceed on
 * `allow`; on `needs_approval` it holds the action until the returned approval is
 * approved; on `deny` it drops the action.
 */
export async function authorizeConnectorAction(
  input: AuthorizeConnectorActionInput,
): Promise<AuthorizeConnectorActionResult> {
  const { orgId, agentId, connectorId, action } = input

  // Fail closed on a missing / cross-tenant agent — never allow.
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  if (!agent || agent.orgId !== orgId) {
    return { decision: 'deny', reason: 'agent not found in org', classification: 'unknown' }
  }
  const meta = getAgentConnector(connectorId)
  if (!meta) {
    return { decision: 'deny', reason: 'unknown connector', classification: 'unknown' }
  }

  const row = await db.query.agentConnectors.findFirst({
    where: and(
      eq(schema.agentConnectors.orgId, orgId),
      eq(schema.agentConnectors.agentId, agentId),
      eq(schema.agentConnectors.connectorId, connectorId),
    ),
  })
  // Configured = a row exists and isn't explicitly disabled. A disabled/absent
  // connector is not usable → deny (below, via connectorConfigured=false).
  const connectorConfigured = !!row && row.status !== 'disabled' && row.status !== 'not_configured'
  const trustLevel = normalizeTrustLevel(row?.trustLevel)

  const permissions = parseCapabilities(agent.permissions)
  const hasCapability = hasConnectorCapability(permissions, connectorId)
  const classification = classifyConnectorAction(connectorId, action)

  const decided = decideConnectorAuthorization({ hasCapability, connectorConfigured, classification, trustLevel })
  if (decided.decision !== 'needs_approval') {
    return decided
  }

  const filed = await fileConnectorActionApproval({
    orgId, agentId, connectorId, connectorName: meta.name, action, classification, target: input.target ?? null,
  })
  if (!filed.ok) {
    // A payload we can't render is itself a fail-closed signal — hold the action but
    // do NOT auto-file a malformed card; surface the reason.
    return { ...decided, reason: `needs approval (could not render card: ${filed.error})` }
  }
  return { ...decided, approvalId: filed.approvalId }
}

// ─── 5. Filing a connector_action approval (the ONE shared path) ───────────────

export interface FiledConnectorApproval {
  ok: boolean
  approvalId?: string
  error?: string
}

// ─── Params binding (NIT-1) — the approved params ARE the executed params ───────
//
// CONN-8a bound an approval to (connectorId, action, agentId) but NOT the params, so an
// operator who approved "gmail.send to bob@x subject Y" could have the agent redeem the
// SAME approval to send to eve@evil with different content. For a parameterized,
// high-consequence action (email/calendar/…) that breaks approval fidelity. The fix: at
// file time we compute a SERVER-side digest of the exact params the agent submitted with
// the needs_approval request and store it on the approval; at redemption the framework
// recomputes the digest from the params the agent submits and REQUIRES a match — so the
// approved params can never diverge from the executed params. The agent cannot forge the
// stored digest (it is computed here, not taken from the payload).

/** Recursively sort object keys so the JSON encoding is stable regardless of the order
 *  the agent happened to serialize its params in. Arrays keep order (order is meaningful);
 *  primitives pass through. Pure. */
function canonicalizeForDigest(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalizeForDigest)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalizeForDigest((v as any)[k])
    return out
  }
  return v
}

/** A stable sha256 hex digest of the connector-action params. Same input (regardless of
 *  key order) → same digest, so file-time and redeem-time comparisons agree. Pure. */
export function connectorParamsDigest(params: Record<string, unknown> | null | undefined): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeForDigest(params ?? {}))).digest('hex')
}

/** Strip control chars + bound a value for safe display on the operator's card. */
function safeCardField(v: unknown, max = 200): string {
  return String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
}

/**
 * Derive the approval card's TARGET line SERVER-SIDE from the real params for known,
 * high-consequence parameterized actions — so what the operator sees is what will
 * actually happen, not an agent-supplied label. Only non-sensitive identifying fields are
 * surfaced (recipient / subject / event title / file name / id) — NEVER a body/content.
 * Returns null for actions we don't specifically describe (the caller then falls back to
 * the agent-supplied target). Pure.
 */
export function deriveConnectorApprovalTarget(connectorId: string, action: string, params: Record<string, unknown> | null | undefined): string | null {
  const p = params ?? {}
  if (connectorId === 'google') {
    switch (action) {
      case 'gmail.send': {
        const to = safeCardField(p.to, 200)
        if (!to) return null
        const subject = safeCardField(p.subject, 140)
        const cc = safeCardField(p.cc, 200)
        return `to ${to}${cc ? ` (cc ${cc})` : ''}${subject ? ` — "${subject}"` : ''}`
      }
      case 'calendar.event.create': {
        const summary = safeCardField(p.summary, 140)
        if (!summary) return null
        const start = safeCardField(p.start, 40)
        return `"${summary}"${start ? ` @ ${start}` : ''}`
      }
      case 'drive.file.create': {
        const name = safeCardField(p.name, 140)
        return name ? `create "${name}"` : null
      }
      case 'drive.file.update': {
        const id = safeCardField(p.fileId ?? p.id, 140)
        return id ? `update file ${id}` : null
      }
      case 'calendar.event.delete': {
        const id = safeCardField(p.eventId ?? p.id, 140)
        return id ? `delete event ${id}` : null
      }
      case 'drive.file.delete': {
        const id = safeCardField(p.fileId ?? p.id, 140)
        return id ? `delete file ${id}` : null
      }
      case 'gmail.delete': {
        const id = safeCardField(p.id ?? p.messageId, 140)
        return id ? `trash message ${id}` : null
      }
    }
  }
  return null
}

/**
 * File a pending, dangerous `connector_action` approval for a WRITE / DESTRUCTIVE /
 * UNKNOWN connector action, and return its id. `prepareApprovalRecord` machine-renders
 * the summary from the STRUCTURED action (never model prose) and stamps
 * `requiresStepUp:true`, so the decide route (routes/tasks.ts) demands a fresh command
 * session to approve — the same step-up the phone/desk enforce.
 *
 * This is the SINGLE code path that files a connector approval: both the CONN-7
 * `authorizeConnectorAction` entry point AND the CONN-8a execution framework call it,
 * so an approval card can never drift between "authorize" and "execute". NEVER pass a
 * credential in — `target`/`action` are the only free-form fields and they land on the
 * card verbatim.
 *
 * NIT-1: when `params` are supplied (the execution framework always does), the card
 * TARGET is derived SERVER-SIDE from them for known high-consequence actions (so the
 * operator sees the real recipient/subject, not an agent label), and a server-computed
 * `paramsDigest` is stored on the action so redemption can require the executed params to
 * equal the approved ones.
 */
export async function fileConnectorActionApproval(input: {
  orgId: string
  agentId: string
  connectorId: string
  connectorName: string
  action: string
  classification: ConnectorActionClass
  target?: string | null
  params?: Record<string, unknown> | null
}): Promise<FiledConnectorApproval> {
  // Server-derived card target for known parameterized actions; else the caller's label.
  const derivedTarget = deriveConnectorApprovalTarget(input.connectorId, input.action, input.params)
  const prepared = prepareApprovalRecord({
    type: 'connector_action',
    action: {
      connectorId: input.connectorId,
      connectorName: input.connectorName,
      action: input.action,
      classification: input.classification,
      agentId: input.agentId,
      target: derivedTarget ?? input.target ?? null,
      // Server-computed binding — the agent cannot forge it (it is NOT read back from the
      // payload; redemption recomputes it from the submitted params and requires a match).
      paramsDigest: connectorParamsDigest(input.params),
    },
  })
  if (!prepared.ok) return { ok: false, error: prepared.error }

  const approvalId = randomUUID()
  await db.insert(schema.approvalRequests).values({
    id: approvalId,
    orgId: input.orgId,
    type: 'connector_action',
    summary: prepared.summary,
    payload: prepared.payload,
    status: 'pending',
    requestedByAgentId: input.agentId,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date(),
  } as any)
  // Ping the owner's phone the moment a connector approval is filed (fire-and-forget).
  notifyApprovalCreated({ id: approvalId, orgId: input.orgId, type: 'connector_action', summary: prepared.summary ?? '' }).catch(() => {})

  return { ok: true, approvalId }
}
