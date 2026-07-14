// Epic ONB / ONB1 — the SERVER-SIDE ADAPTER REGISTRY.
//
// Today `agents.runtime` is a 4-value column and everything a runtime actually
// needs (which adapter binary, which env, which config fields, which of those
// fields are secrets) lives CLIENT-SIDE ONLY in `web/lib/adapterProfile.ts`.
// That is fine for printing an `mc.env` in a wizard and useless for an agent
// onboarding itself over HTTP: a joining agent must be able to *discover* the
// taxonomy, and the server must be able to *validate* the config it submits.
//
// This module is that single source of truth. It is PURE and table-driven — no
// I/O, no DB, no env — so ONB2 (the generated onboarding doc), ONB3 (join-request
// payload validation) and ONB6 (the invite UI) all read the same table, and a
// new runtime is one row.
//
// Two rules that are load-bearing, not stylistic:
//
//  * **Declared ≠ available.** An adapter may be *declared* (so the onboarding
//    doc can describe the whole taxonomy honestly) but `available: false`, in
//    which case a join request naming it is refused with a clear reason. An
//    honest 404 beats silent half-support.
//  * **Secret-shaped fields never land in a plaintext config column.** Fields
//    flagged `secret` are split out of the payload by `validateDefaultsPayload`
//    and are the caller's job to put in the encrypted store (`services/secrets.ts`).
//    Any *undeclared* key that merely LOOKS like a secret is rejected outright —
//    fail-closed, so a hostile payload cannot smuggle a credential into config.
//
// And one safety default that must never regress: `claude_code`'s permissionMode
// defaults to `plan` (propose-and-approve). The registry must NEVER hand out an
// autonomous default — CC6 puts autonomy behind two explicit host guards plus the
// CC5 denylist, and onboarding is not a back door around them.

import { isForbiddenKey, isSecretShapedKey } from './config-bundle'

export const ADAPTER_KINDS = ['local', 'gateway', 'http', 'internal'] as const
export type AdapterKind = (typeof ADAPTER_KINDS)[number]

export type FieldType = 'string' | 'number' | 'boolean' | 'object'

export interface AdapterField {
  key: string
  type: FieldType
  required?: boolean
  /** Routed to the encrypted secret store, never to a config column. */
  secret?: boolean
  /** Allowed values (validated) — used for `permissionMode`, `executor`, … */
  enum?: readonly string[]
  /** The value used when the joining agent omits the field. */
  default?: string | number | boolean
  description: string
}

export interface AdapterCapabilities {
  supportsInstructionsBundle: boolean
  supportsSkills: boolean
  /** Cursor's quirk: skills must be materialized as files on the runtime host. */
  requiresMaterializedRuntimeSkills: boolean
  supportsModelProfiles: boolean
  /** The runtime can execute commands on a host → CC3 secure-by-default applies. */
  executesHostCommands: boolean
}

export interface AdapterEntry {
  type: string
  label: string
  kind: AdapterKind
  /** Can an agent actually onboard onto this runtime today? */
  available: boolean
  /** Can an INVITE name this adapter? (`internal` cannot — we run those.) */
  invitable: boolean
  /** The value written to the legacy `agents.runtime` column. Keeps the registry
   *  additive: nothing about the existing column or its enum changes. */
  runtime: 'openclaw' | 'cursor' | 'claude_code' | 'custom'
  capabilities: AdapterCapabilities
  /** The `agentDefaultsPayload` contract for this adapter. */
  fields: AdapterField[]
  /** A worked example — ONB2's onboarding doc prints this per allowed runtime. */
  example: Record<string, unknown>
  note: string
}

const caps = (over: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  supportsInstructionsBundle: true,
  supportsSkills: true,
  requiresMaterializedRuntimeSkills: false,
  supportsModelProfiles: true,
  executesHostCommands: false,
  ...over,
})

/** The registry. One row per adapterType; order is the display order. */
const ADAPTERS: AdapterEntry[] = [
  {
    type: 'openclaw_local',
    label: 'OpenClaw (local poll loop)',
    kind: 'local',
    available: true,
    invitable: true,
    runtime: 'openclaw',
    capabilities: caps({ executesHostCommands: true }),
    fields: [
      { key: 'workdir', type: 'string', required: true, description: 'Absolute path the adapter runs in.' },
      { key: 'pollSeconds', type: 'number', default: 20, description: 'Task poll interval, seconds.' },
      { key: 'executor', type: 'string', enum: ['auto', 'shell', 'llm', 'http'], default: 'auto', description: 'How the adapter executes a task.' },
      { key: 'allowShell', type: 'boolean', default: false, description: 'Permit shell execution on the host. Off unless the operator opts in.' },
      { key: 'mcApiUrl', type: 'string', description: 'Mission Control base URL the agent reached (from the /api/health probe).' },
    ],
    example: { workdir: '/Users/you/checkout', pollSeconds: 20, executor: 'auto', allowShell: false, mcApiUrl: 'https://7ei-backend.fly.dev' },
    note: 'What ships today (runtime: openclaw). The LLM key is served from the encrypted store via GET /api/agent/secrets — never put it in the payload.',
  },
  {
    type: 'openclaw_gateway',
    label: 'OpenClaw gateway (WebSocket)',
    kind: 'gateway',
    available: false,
    invitable: true,
    runtime: 'openclaw',
    capabilities: caps({ executesHostCommands: true }),
    fields: [
      { key: 'url', type: 'string', required: true, description: 'Gateway WebSocket URL — ws:// or wss:// only.' },
      { key: 'x-openclaw-token', type: 'string', secret: true, required: true, description: 'Gateway auth token. Goes to the encrypted secret store, never to a config column.' },
      { key: 'mcApiUrl', type: 'string', description: 'Mission Control base URL the agent reached.' },
      { key: 'waitTimeoutMs', type: 'number', default: 120000, description: 'How long to wait for a gateway turn to finish.' },
      { key: 'sessionKeyStrategy', type: 'string', enum: ['issue', 'reuse'], default: 'issue', description: 'Session key handling for the gateway connection.' },
    ],
    example: { url: 'wss://gateway.example/ws', 'x-openclaw-token': '<sent once; stored encrypted>', mcApiUrl: 'https://7ei-backend.fly.dev', waitTimeoutMs: 120000, sessionKeyStrategy: 'issue' },
    note: 'Declared, not yet available: the dispatch half (MC → gateway) is not built. A join request naming it is refused with that reason.',
  },
  {
    type: 'claude_code',
    label: 'Claude Code (local CLI)',
    kind: 'local',
    available: true,
    invitable: true,
    runtime: 'claude_code',
    capabilities: caps({ executesHostCommands: true }),
    fields: [
      { key: 'workdir', type: 'string', required: true, description: 'Absolute path to the code checkout the agent works in.' },
      { key: 'model', type: 'string', description: 'Optional model override for the CLI.' },
      // NEVER default this to an autonomous mode. CC6 gates autonomy behind two
      // explicit host guards + the CC5 denylist; onboarding is not a way around them.
      { key: 'permissionMode', type: 'string', enum: ['plan', 'acceptEdits'], default: 'plan', description: 'Propose-and-approve (plan) by default. Autonomous host execution is NOT selectable here — it stays behind the adapter host guards (CC6) and the command denylist (CC5).' },
      { key: 'manageWorktree', type: 'boolean', default: false, description: 'Let the adapter manage a git worktree per task.' },
      { key: 'timeoutSeconds', type: 'number', default: 900, description: 'Per-task CLI timeout.' },
    ],
    example: { workdir: '/Users/you/checkout', permissionMode: 'plan', manageWorktree: false, timeoutSeconds: 900 },
    note: 'Shipped (CC1–CC6). Registers CONTAINED: low_trust_review + an explicit capability list (secureRegistration, CC3). Plan mode by default — nothing runs on the host without an approval.',
  },
  {
    type: 'cursor',
    label: 'Cursor (file inbox)',
    kind: 'local',
    available: true,
    invitable: true,
    runtime: 'cursor',
    capabilities: caps({ requiresMaterializedRuntimeSkills: true }),
    fields: [
      { key: 'inbox', type: 'string', required: true, default: './coordination/inbox', description: 'Directory the adapter writes work orders into.' },
      { key: 'pollSeconds', type: 'number', default: 20, description: 'Task poll interval, seconds.' },
    ],
    example: { inbox: './coordination/inbox', pollSeconds: 20 },
    note: 'Shipped (adapters/cursor). Skills must be materialized as files on the host — the only adapter that needs it.',
  },
  {
    type: 'openai_generic',
    label: 'OpenAI-compatible endpoint (generic)',
    kind: 'http',
    available: true,
    invitable: true,
    runtime: 'custom',
    capabilities: caps(),
    fields: [
      { key: 'baseUrl', type: 'string', required: true, description: 'Any OpenAI-chat-compatible base URL.' },
      { key: 'model', type: 'string', required: true, description: 'Model id at that endpoint.' },
      { key: 'apiKey', type: 'string', secret: true, description: 'Provider key — goes to the encrypted secret store.' },
      { key: 'headers', type: 'object', description: 'Extra request headers (no credentials — use apiKey).' },
    ],
    example: { baseUrl: 'https://api.example/v1', model: 'some-model', apiKey: '<sent once; stored encrypted>' },
    note: 'The map-any-runtime escape hatch — adapters/presets/*.env are already exactly this shape.',
  },
  {
    type: 'http_webhook',
    label: 'HTTP webhook (push)',
    kind: 'http',
    available: false,
    invitable: true,
    runtime: 'custom',
    capabilities: caps({ supportsSkills: false }),
    fields: [
      { key: 'externalEndpoint', type: 'string', required: true, description: 'HTTPS URL Mission Control pushes work to.' },
      { key: 'method', type: 'string', enum: ['POST', 'PUT'], default: 'POST', description: 'HTTP method for the push.' },
      { key: 'webhookAuthHeader', type: 'string', secret: true, description: 'Authorization header value — encrypted store.' },
    ],
    example: { externalEndpoint: 'https://agent.example/hook', method: 'POST' },
    note: 'Declared, not yet available: agents.external_endpoint exists as a column but the dispatch half is not built. Needs ONB5 (SSRF-hardened reachability) before it can go available.',
  },
  {
    type: 'hermes_gateway',
    label: 'Hermes gateway (HTTP)',
    kind: 'gateway',
    available: false,
    invitable: true,
    runtime: 'custom',
    capabilities: caps(),
    fields: [
      { key: 'apiBaseUrl', type: 'string', required: true, description: 'Hermes API base URL (default port 8642).' },
      { key: 'apiKey', type: 'string', secret: true, required: true, description: 'The HERMES gateway key — NOT a Mission Control key. Encrypted store.' },
      { key: 'mcApiUrl', type: 'string', description: 'Mission Control base URL the agent reached.' },
    ],
    example: { apiBaseUrl: 'http://127.0.0.1:8642', apiKey: '<the Hermes key, not the MC key>' },
    note: 'Declared, not built — we have no Hermes install. apiKey is the single most confusable field in the flow: it is the Hermes key, never the Mission Control token.',
  },
  {
    type: 'hermes_local',
    label: 'Hermes (local process)',
    kind: 'local',
    available: false,
    invitable: true,
    runtime: 'custom',
    capabilities: caps({ executesHostCommands: true }),
    fields: [
      { key: 'command', type: 'string', required: true, description: 'Command Mission Control starts on its own host.' },
      { key: 'env', type: 'object', description: 'Non-secret env for the process.' },
    ],
    example: { command: 'hermes gateway run' },
    note: 'Declared, not available: only meaningful for a self-hosted/packaged Mission Control — our backend runs on Fly and does not start host processes.',
  },
  {
    type: 'grok_local',
    label: 'Grok (local CLI)',
    kind: 'local',
    available: false,
    invitable: true,
    runtime: 'custom',
    capabilities: caps({ executesHostCommands: true }),
    fields: [
      { key: 'workdir', type: 'string', required: true, description: 'Absolute path the CLI runs in.' },
      { key: 'model', type: 'string', description: 'Grok model id.' },
    ],
    example: { workdir: '/Users/you/checkout', model: 'grok-latest' },
    note: 'Declared, not built. The API flavour is covered today by openai_generic via the LLM router.',
  },
  {
    type: 'internal',
    label: 'Internal (Mission Control-run)',
    kind: 'internal',
    available: true,
    invitable: false,
    runtime: 'custom',
    capabilities: caps({ executesHostCommands: false }),
    fields: [],
    example: {},
    note: 'Not an adapter — agents Mission Control runs itself (Arturita et al.). CANNOT be invited: there is no external runtime to onboard.',
  },
]

const BY_TYPE = new Map(ADAPTERS.map((a) => [a.type, a]))

export function listAdapters(): AdapterEntry[] {
  return ADAPTERS.map((a) => ({ ...a }))
}

export function adapterTypes(): string[] {
  return ADAPTERS.map((a) => a.type)
}

export function getAdapter(type: string | null | undefined): AdapterEntry | null {
  return BY_TYPE.get(String(type ?? '').trim()) ?? null
}

/** Adapter types an invite may name: declared, invitable — available or not.
 *  (An unavailable one is *declarable* so the doc stays a complete map, but a
 *  join naming it is refused at join time with a reason.) */
export function invitableAdapterTypes(): string[] {
  return ADAPTERS.filter((a) => a.invitable).map((a) => a.type)
}

/** Adapter types an agent can actually onboard onto right now. */
export function joinableAdapterTypes(): string[] {
  return ADAPTERS.filter((a) => a.invitable && a.available).map((a) => a.type)
}

export function secretFields(type: string): string[] {
  return (getAdapter(type)?.fields ?? []).filter((f) => f.secret).map((f) => f.key)
}

/**
 * EVERY field key any adapter declares `secret: true`, across the whole registry.
 *
 * This registry is the source of truth for what an adapter's secrets are CALLED, so
 * it must also be the source of truth for what the audit log redacts. `sanitizeBody`
 * (`middleware/audit-log.ts`) used to test key names against a hand-written list
 * (`key|token|secret|password|…`) that `http_webhook`'s `webhookAuthHeader` — a
 * bearer Authorization header value — matched none of. The onboarding document tells
 * a joining agent to send exactly these keys inside `agentDefaultsPayload`, so the
 * two lists drifting apart is a plaintext credential in `audit_logs.metadata`.
 * `audit-onb2-reaudit.test.ts` fails if a new adapter adds a secret field this does
 * not cover.
 */
export function allSecretFieldKeys(): string[] {
  return [...new Set(ADAPTERS.flatMap((a) => (a.fields ?? []).filter((f) => f.secret).map((f) => f.key)))]
}

/** Map an adapterType onto the legacy `agents.runtime` column value. */
export function runtimeForAdapter(type: string): string | null {
  return getAdapter(type)?.runtime ?? null
}

// ─── Payload validation ─────────────────────────────────────────────────────

/** Hard caps on a payload submitted by an untrusted (not-yet-approved) party. */
export const MAX_PAYLOAD_BYTES = 8 * 1024
export const MAX_PAYLOAD_KEYS = 40
export const MAX_STRING_FIELD_CHARS = 2000

export interface PayloadValidation {
  ok: boolean
  errors: string[]
  /** Non-secret fields, defaults applied — safe for a plaintext config column. */
  config: Record<string, unknown>
  /** Secret-flagged fields, lifted out — the caller writes these to `secrets.ts`. */
  secrets: Record<string, string>
}

const fail = (errors: string[]): PayloadValidation => ({ ok: false, errors, config: {}, secrets: {} })

/**
 * Validate an `agentDefaultsPayload` against an adapter's declared contract.
 *
 * Fail-closed by construction:
 *  - unknown adapterType, or one that is not invitable/available → refused;
 *  - keys not in the adapter's field list → refused (allowlist, not sanitize);
 *  - `__proto__`/`constructor`/`prototype` → refused (prototype pollution);
 *  - an UNDECLARED key that looks secret-shaped → refused, so a hostile payload
 *    cannot smuggle a credential into a plaintext column;
 *  - size + key-count + string-length caps;
 *  - enum + type checks; defaults applied for omitted fields;
 *  - declared-secret fields are split into `secrets`, never into `config`.
 */
export function validateDefaultsPayload(
  adapterType: string,
  payload: unknown,
  opts: { requireAvailable?: boolean } = {},
): PayloadValidation {
  const adapter = getAdapter(adapterType)
  if (!adapter) return fail([`unknown adapterType: ${String(adapterType)}`])
  if (!adapter.invitable) return fail([`adapterType ${adapter.type} cannot be invited`])
  if (opts.requireAvailable !== false && !adapter.available) {
    return fail([`adapterType ${adapter.type} is declared but not available: ${adapter.note}`])
  }

  const raw = payload ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail(['agentDefaultsPayload must be an object'])

  const entries = Object.entries(raw as Record<string, unknown>)
  const errors: string[] = []
  if (entries.length > MAX_PAYLOAD_KEYS) errors.push(`agentDefaultsPayload has too many keys (${entries.length} > ${MAX_PAYLOAD_KEYS})`)
  let size = 0
  try {
    size = JSON.stringify(raw).length
  } catch {
    return fail(['agentDefaultsPayload is not serializable'])
  }
  if (size > MAX_PAYLOAD_BYTES) errors.push(`agentDefaultsPayload is too large (${size} > ${MAX_PAYLOAD_BYTES} bytes)`)

  const byKey = new Map(adapter.fields.map((f) => [f.key, f]))
  const config: Record<string, unknown> = {}
  const secrets: Record<string, string> = {}

  for (const [key, value] of entries) {
    if (isForbiddenKey(key)) {
      errors.push(`forbidden key: ${key}`)
      continue
    }
    const field = byKey.get(key)
    if (!field) {
      // An undeclared key that LOOKS like a credential is refused loudly rather
      // than dropped quietly — a dropped credential is a credential the joining
      // agent thinks it configured.
      errors.push(isSecretShapedKey(key)
        ? `secret-shaped key ${key} is not part of the ${adapter.type} contract — refused (put credentials only in declared secret fields)`
        : `unknown field for ${adapter.type}: ${key}`)
      continue
    }
    if (value === null || value === undefined) continue

    if (field.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`${key} must be an object`); continue }
      const bad = Object.keys(value as object).find((k) => isForbiddenKey(k))
      if (bad) { errors.push(`forbidden key in ${key}: ${bad}`); continue }
      config[key] = value
      continue
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${key} must be a number`); continue }
      config[key] = value
      continue
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') { errors.push(`${key} must be a boolean`); continue }
      config[key] = value
      continue
    }
    // string
    if (typeof value !== 'string') { errors.push(`${key} must be a string`); continue }
    if (value.length > MAX_STRING_FIELD_CHARS) { errors.push(`${key} is too long (max ${MAX_STRING_FIELD_CHARS} chars)`); continue }
    if (field.enum && !field.enum.includes(value)) { errors.push(`${key} must be one of: ${field.enum.join(', ')}`); continue }
    if (field.secret) secrets[key] = value
    else config[key] = value
  }

  // Defaults for omitted fields, then required-field check. A secret has no
  // default by construction — we never invent a credential.
  for (const field of adapter.fields) {
    if (field.secret) continue
    if (config[field.key] === undefined && field.default !== undefined) config[field.key] = field.default
  }
  for (const field of adapter.fields) {
    if (!field.required) continue
    const present = field.secret ? secrets[field.key] !== undefined : config[field.key] !== undefined
    if (!present) errors.push(`missing required field for ${adapter.type}: ${field.key}`)
  }

  if (errors.length > 0) return fail(errors)
  return { ok: true, errors: [], config, secrets }
}

/** The public view of the registry (`GET /api/adapters`). Identical to the table
 *  — there is nothing secret in it — but stated explicitly so a future field with
 *  an internal-only meaning cannot leak by being added to the row. */
export function publicRegistry(): Array<Omit<AdapterEntry, never>> {
  return listAdapters().map((a) => ({
    type: a.type,
    label: a.label,
    kind: a.kind,
    available: a.available,
    invitable: a.invitable,
    runtime: a.runtime,
    capabilities: { ...a.capabilities },
    fields: a.fields.map((f) => ({ ...f })),
    example: { ...a.example },
    note: a.note,
  }))
}
