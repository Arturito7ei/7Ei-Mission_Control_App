// Shared API client for the iPhone remote. Mirrors web/lib/api.ts: one place for
// base-URL joining, the bearer header, and error mapping — including the
// transport-error distinction (a failed write to a reachable API reads very
// differently from a dead backend). The bearer is a Clerk JWT (or, in phase-1
// token-paste mode, a Clerk session token the operator pasted).

// MOB-6d — the wire shapes for the timeline and budgets are DEFINED in the pure
// modules that read them (activity.ts / costs.ts) and imported here, rather than
// re-declared. Both are React-free by design (their tests load them under
// `node --test`), so importing them costs this module nothing — and one
// definition per wire shape means a field rename can't leave the client agreeing
// with itself while disagreeing with the backend.
import type { TimelineLite } from './activity'
import type { BudgetLite } from './costs'
// MOB-6e — same rule: the vault and org-chart wire shapes are defined in the
// pure modules that read them (memory.ts / org.ts) and imported here.
import type { VaultCfgLite, VaultEntryLite } from './memory'
import type { OrgAgentLite } from './org'
// MOB-6f — same rule: the governance, connector and settings wire shapes are
// defined in the pure modules that read them.
import type { GovAgentLite, PolicyLite, RevisionLite } from './governance'
import type { ConnectorRowLite } from './connectors'
import type { OrgSettingsLite } from './settings'
// MOB-7d — the agent-editor wire shapes live in the pure module that reads them
// (agentEdit.ts), imported here so there is ONE definition of the skills payload,
// not a second the client could drift from.
import type { SkillsPayload } from './agentEdit'
// CONN-3 — the per-agent connector wire shape is defined in the pure module that
// reads it (agentConnectors.ts, itself a parity-pinned mirror of the web's), so
// there is ONE definition of the MASKED connector projection. NOTE the security
// invariant it encodes: the read shape carries NO secret / token / secretRef —
// only status + non-secret config + a derived label. A credential is WRITE-ONLY.
import type { PublicConnectorState } from './agentConnectors'

export type ApiInit = RequestInit & { token?: string | null; base?: string }

export function transportError(method: string, path: string): string {
  const m = method.toUpperCase()
  const where = `${m} ${path}`
  return m === 'GET' || m === 'HEAD'
    ? `Network error — could not reach the backend (${where}). Check your connection / API URL.`
    : `Network error — could not send ${where}. The backend is unreachable or refused the request.`
}

function headers(init?: ApiInit): Record<string, string> {
  const { token, body, headers } = init ?? {}
  // A FormData body must NOT carry a hand-set Content-Type: the runtime sets
  // `multipart/form-data; boundary=…` itself, and the boundary is the only thing
  // that makes the parts parseable. Declaring `application/json` over multipart
  // is the same class of trap as the empty-JSON-body 400 — the request looks
  // well-formed and the server rejects it for a reason the client never names.
  const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body != null && !isMultipart ? { 'Content-Type': 'application/json' } : {}),
    ...((headers ?? {}) as Record<string, string>),
  }
}

export async function api<T>(base: string, path: string, init?: ApiInit): Promise<T> {
  const { token, base: _b, ...opts } = init ?? {}
  const method = (opts.method ?? 'GET').toUpperCase()
  let res: Response
  try {
    res = await fetch(`${base}${path}`, { ...opts, headers: headers(init) })
  } catch {
    throw new Error(transportError(method, path))
  }
  if (res.status === 204) return {} as T
  const j: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const errs = j?.errors
    const detail =
      (Array.isArray(errs) && errs.length ? errs.join('; ') : undefined) ?? j?.error
    let msg = `HTTP ${res.status}: ${detail ?? (res.statusText || 'Request failed')}`
    if (res.status === 401 || res.status === 403)
      msg += ' — token invalid, expired, or lacks permission. Re-connect with a fresh token.'
    throw new Error(msg)
  }
  return j as T
}

// ─── Typed endpoint helpers (the surfaces phase-1 exercises) ────────────────

export type Health = {
  status: string
  version?: string
  db?: string
  scheduler?: string
  llm?: { providers?: { key: string; healthy: boolean }[]; unhealthy?: string[] }
}

export type Org = { id: string; name: string; memberRole?: string }

export type Agent = {
  id: string
  name: string
  role?: string | null
  status?: string | null
  runtime?: string | null
  agentType?: string | null
  avatarEmoji?: string | null
  // MOB-7c — the uploaded picture (a base64 data URI), when the org owner set one.
  // The roster (`SELECT *`) and the detail route (whole row) both carry it; absent
  // → the emoji is shown. See avatar.ts / AgentAvatar.tsx.
  avatarUrl?: string | null
  llmProvider?: string | null
  llmModel?: string | null
  heartbeatStatus?: string | null
  trustMode?: string | null
  // MOB-7d — the rest of the editable row (GET /api/agents/:id returns the whole
  // row, so these arrive already; typed here so the editor can prefill and the
  // roster can supply `reportsTo` for the cycle check). All optional/back-compat.
  title?: string | null
  jobDescription?: string | null
  contactChannel?: string | null
  reportsTo?: string | null
  primaryModel?: string | null
  cheapModel?: string | null
  cheapModelEnabled?: boolean | number | null
  reasoningEffort?: string | null
}

/** MOB-7d — a selectable model, as `GET …/available-models` returns it (web's
 *  ConfigurationTab uses the same route to populate its Model picker). */
export type ModelOption = { id: string; label: string; provider: string; tier: string; custom?: boolean }

/**
 * MOB-6b — a task row as the Task Log reads it. The backend returns the whole
 * `tasks` row; these are the fields the web's log renders, plus the ids it joins
 * on. Extra columns are ignored rather than typed — the log is read-only.
 */
export type Task = {
  id: string
  title: string
  status: string
  agentId?: string | null
  projectId?: string | null
  priority?: string | null
  costUsd?: number | null
  tokensUsed?: number | null
  createdAt?: number | string | null
}

/**
 * MOB-6b — the agent Dashboard payload, shaped by the backend's pure
 * `buildAgentOverview` (backend/src/services/agent-overview.ts). The phone reads
 * the same three parts the web's DashboardTab does: the latest run, the recent
 * tasks, and the costs strip. The 14-day chart series (`runActivity`,
 * `successRate`, `tasksByPriority`, `tasksByStatus`) are in the payload and
 * typed here, but only the two distributions are rendered — see
 * AgentDetailScreen for why the day-columns stay on the desk.
 */
export type AgentOverview = {
  agentId: string
  days: number
  latestRun: {
    id: string
    status: string
    taskId: string | null
    summary: string
    startedAt: number | null
    endedAt: number | null
  } | null
  runActivity: { date: string; total: number; succeeded: number; failed: number }[]
  successRate: { date: string; pct: number | null; settled: number }[]
  tasksByPriority: { key: string; count: number }[]
  tasksByStatus: { key: string; count: number }[]
  costs: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    totalTokens: number
    totalCostUsd: number
    taskCount: number
    hasSplit: boolean
  }
}

export type AgentRecentTask = {
  id: string
  title: string
  status: string
  priority: string
  createdAt: number | null
}

export type Approval = {
  id: string
  type: string
  summary?: string | null
  status: string
  requestedByAgentId?: string | null
  decisionNote?: string | null
  createdAt?: number | null
  payload?: any
}

/**
 * Prior turns sent with a /converse call — the web's default, mirrored.
 *
 * The web's `toConverseRequest` defaults `historyLimit` to 10 and its panel never
 * overrides it (web/app/dashboard/assistant.logic.ts). The phone used to send 20:
 * the backend's zod `.max(20)` is the CEILING, not the contract, so both clients
 * were legal but Arturita remembered twice as far on the phone as on the desk —
 * the same question, asked from two devices, could get two different answers.
 * Same conversation, same depth.
 */
export const CONVERSE_HISTORY_LIMIT = 10

export type ConverseReply = { text: string; provider?: string; model?: string }
export type ConverseResult = {
  mode: 'answer' | 'delegate'
  routing?: { trigger?: string; reason?: string; workMode?: string; destructive?: boolean }
  reply?: ConverseReply
  taskId?: string
  degraded?: boolean
  error?: string
  /** MOB-7b: `no_vision_model` — a photo was sent but no configured model can
   *  see it. Degraded like a no-LLM reply, but for a different reason and with a
   *  different fix, so the two must not be reported to the operator as one. */
  code?: string
}

export const Api = {
  health: (base: string) => api<Health>(base, '/api/health'),

  // Owned orgs for the current user (simplest orgId resolution after sign-in).
  orgs: (base: string, token: string) =>
    api<{ orgs: Org[] }>(base, '/api/orgs', { token }).then((r) => r.orgs ?? []),

  agents: (base: string, token: string, orgId: string) =>
    api<{ agents: Agent[] }>(base, `/api/orgs/${orgId}/agents`, { token }).then(
      (r) => r.agents ?? [],
    ),

  // ─── MOB-6b — the agent detail screen ─────────────────────────────────────
  // Identity, verbatim from the web's AgentDetail: GET /api/agents/:agentId.
  // This one is NOT org-scoped — a deliberate backend shape, not an oversight on
  // our side. `requireOrgRole` reads `:orgId` off the path and silently no-ops
  // without one (backend/src/routes/agent-detail.ts says so at the top), so this
  // route is gated instead by the top-level membership gate that #264 closed.
  // The phone only ever asks for an agent it just listed from its own org.
  agent: (base: string, token: string, agentId: string) =>
    api<{ agent: Agent }>(base, `/api/agents/${agentId}`, { token }).then((r) => r.agent),

  // The Dashboard-tab payload — the org-scoped route, exactly as the web's
  // DashboardTab calls it. Same endpoint, same field names: one contract.
  agentOverview: (base: string, token: string, orgId: string, agentId: string) =>
    api<{ overview: AgentOverview; recentTasks: AgentRecentTask[] }>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/overview`,
      { token },
    ),

  // ─── MOB-6b — the Task Log ────────────────────────────────────────────────
  // The SAME call the web's `tasks` tab makes (web/app/dashboard/page.tsx loads
  // `/api/orgs/${o.id}/tasks` into the log). The backend caps at 200 rows and
  // orders newest-first; the log renders the first 100, as the web does
  // (`taskLog.ts` holds that limit and the tests pin it).
  tasks: (base: string, token: string, orgId: string) =>
    api<{ tasks: Task[] }>(base, `/api/orgs/${orgId}/tasks`, { token }).then((r) => r.tasks ?? []),

  // ─── MOB-6d — Activity ────────────────────────────────────────────────────
  // The SAME call the web's Activity section makes: CockpitPanel loads
  // `/api/orgs/${orgId}/timeline` and hands it to TimelineSection. The payload is
  // a 24h swimlane (one lane per agent); the phone flattens it into a feed rather
  // than drawing lanes — see activity.ts for why the chart stays on the desk.
  timeline: (base: string, token: string, orgId: string) =>
    api<{ timeline: TimelineLite }>(base, `/api/orgs/${orgId}/timeline`, { token }).then(
      (r) => r.timeline,
    ),

  // ─── MOB-6d — Budgets (the web's hosted tab under Costs) ───────────────────
  // The SAME call the web's BudgetsSection is fed by. The backend evaluates each
  // policy server-side and returns `spend`, `state` and `pct` alongside it, so
  // both clients render one verdict rather than each deriving their own.
  //
  // Read-only here: the web's section can also POST a new policy and DELETE one,
  // and the phone deliberately does neither — see BudgetsScreen.
  budgets: (base: string, token: string, orgId: string) =>
    api<{ budgets: BudgetLite[] }>(base, `/api/orgs/${orgId}/budgets`, { token }).then(
      (r) => r.budgets ?? [],
    ),

  // ─── MOB-6e — Memory (the Obsidian vault reader) ──────────────────────────
  // The SAME two calls the web's MemoryPanel makes, with the same query param.
  //
  // `tree` lists ONE directory (it's a GitHub Contents call per folder, backend
  // services/vault-connector.ts) — there is no whole-vault endpoint, so the
  // phone's collapsible tree fetches per expand. The response echoes the vault
  // that answered (`repo`/`root`/`branch`), which is how the screen labels itself
  // without also calling `…/connectors/obsidian/config` the way the web does —
  // that endpoint backs the web's vault EDITOR, and the phone is read-only.
  memoryTree: (base: string, token: string, orgId: string, path: string) =>
    api<{ path: string; entries: VaultEntryLite[] } & VaultCfgLite>(
      base,
      `/api/orgs/${orgId}/memory/tree?path=${encodeURIComponent(path)}`,
      { token },
    ),

  // One note's markdown. The backend 400s a non-markdown path, so the screen
  // only ever calls this for a path `isNotePath` already accepted.
  memoryFile: (base: string, token: string, orgId: string, path: string) =>
    api<{ path: string; markdown: string }>(
      base,
      `/api/orgs/${orgId}/memory/file?path=${encodeURIComponent(path)}`,
      { token },
    ),

  // ─── MOB-6e — the Org chart ───────────────────────────────────────────────
  // The SAME call the web's CockpitPanel makes to feed OrgChart.tsx. The payload
  // is `{ tree, agents, count }`; we read `agents` — the FLAT roster — and derive
  // the tree client-side exactly as the web does (web/lib/orgLayout), so neither
  // client can drift onto a second answer for "who reports to whom".
  orgchart: (base: string, token: string, orgId: string) =>
    api<{ agents: OrgAgentLite[]; count: number }>(base, `/api/orgs/${orgId}/orgchart`, {
      token,
    }).then((r) => r.agents ?? []),

  // ─── MOB-6f — Governance (read-only) ──────────────────────────────────────
  // The SAME three calls the web's GovernancePanel makes on load. The web makes
  // a fourth — `…/available-models` — which the phone deliberately does NOT: it
  // exists only to populate the model-profile <select>, and the phone has no
  // editor to populate. Asking for it would be fetching data to render nothing.
  //
  // The web's panel also POSTs a policy, DELETEs one, PATCHes permissions, PUTs
  // trust + model-profile, and POSTs a rollback. The phone does NONE of those —
  // see GovernanceScreen for why (this surface decides what an agent may do).
  policies: (base: string, token: string, orgId: string) =>
    api<{ policies: PolicyLite[] }>(base, `/api/orgs/${orgId}/policies`, { token }).then(
      (r) => r.policies ?? [],
    ),

  revisions: (base: string, token: string, orgId: string) =>
    api<{ revisions: RevisionLite[] }>(base, `/api/orgs/${orgId}/revisions`, { token }).then(
      (r) => r.revisions ?? [],
    ),

  // The governance projection of the roster. Same endpoint as `agents` above —
  // the web's Governance panel calls that exact URL — but typed to the columns
  // this screen reads (`permissions`, `trustMode`, `trustBoundary`), which the
  // roster's `Agent` doesn't carry. One call, two readings, no second contract.
  governanceAgents: (base: string, token: string, orgId: string) =>
    api<{ agents: GovAgentLite[] }>(base, `/api/orgs/${orgId}/agents`, { token }).then(
      (r) => r.agents ?? [],
    ),

  // ─── MOB-6f — Connectors (read-only) ──────────────────────────────────────
  // The SAME call the web's ConnectorsPanel loads with. The backend merges its
  // registry metadata with the org's live status and returns `detail` as an
  // ACCOUNT LABEL — never a credential (backend/src/routes/connectors.ts).
  //
  // Read-only here: the web can also POST /connect (or bounce to Google's
  // consent screen), POST /test, and DELETE the connector. The phone does none.
  connectors: (base: string, token: string, orgId: string) =>
    api<{ connectors: ConnectorRowLite[] }>(base, `/api/orgs/${orgId}/connectors`, {
      token,
    }).then((r) => r.connectors ?? []),

  // ─── MOB-6f — Settings (read-only) ────────────────────────────────────────
  // The web's Settings tab reads its three fields off the ORG, which arrives
  // with the org list (page.tsx seeds `settings` from the loaded org). Same
  // source here — no new endpoint, because the web has none to mirror.
  //
  // ⚠ This payload is the whole `organisations` row, which includes a
  // `telegramBotToken` column (see settings.ts). Callers must read it through
  // the `SETTINGS_FIELDS` allow-list and never spread it. `OrgSettingsLite`
  // types only the harmless fields so that stays hard to get wrong.
  orgSettings: (base: string, token: string) =>
    api<{ orgs: OrgSettingsLite[] }>(base, '/api/orgs', { token }).then((r) => r.orgs ?? []),

  pendingApprovals: (base: string, token: string, orgId: string) =>
    api<{ approvals: Approval[] }>(base, `/api/orgs/${orgId}/approvals?status=pending`, {
      token,
    }).then((r) => r.approvals ?? []),

  // Decide an approval. For a DANGEROUS type approved from the phone, the backend
  // requires STEP-UP: a fresh Arturita command-session token presented in the
  // `x-arturita-session` header (backend/src/routes/tasks.ts — approve of
  // file_destructive/wallet_tx/email_send/machine_exec else 403). `sessionToken`
  // is that step-up token, minted per-approval via `mintArturitaSession` right
  // before this call. Reject/revision never step up, so they pass it undefined.
  // The token is a bearer-grade secret: it rides in a header (NEVER a URL/query)
  // and is NEVER logged. The same contract accepts a body `sessionToken`, but the
  // header is the primary path the web gate reads, so we use the header only.
  decideApproval: (
    base: string,
    token: string,
    id: string,
    decision: 'approved' | 'rejected' | 'revision_requested',
    note?: string,
    sessionToken?: string,
  ) =>
    api<{ approval: Approval }>(base, `/api/approvals/${id}/decide`, {
      token,
      method: 'POST',
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
      ...(sessionToken ? { headers: { 'x-arturita-session': sessionToken } } : {}),
    }),

  // ─── Step-up: mint a fresh Arturita command session (MOB-4) ────────────────
  // Clerk-authed owner surface: POST /api/orgs/:orgId/arturita/session returns a
  // one-shot `token` (the backend stores only its hash) that is FRESH for the
  // step-up window (backend DEFAULT_STEPUP_FRESHNESS_MS = 5 min) and valid for the
  // session TTL (30 min). We mint one PER dangerous approval right before deciding
  // and discard it after — never cache or reuse it across approvals, matching the
  // backend's freshness/single-operator intent. `source` is a descriptive label
  // on the sessions list; the enum is {desk, telegram} and the phone authenticates
  // exactly like the web desk (first-party Clerk JWT), so we mint as 'desk'. The
  // returned token is a secret: hold it only in a local var, attach it to the one
  // decide call, and NEVER log it or put it in a URL.
  mintArturitaSession: (base: string, token: string, orgId: string) =>
    api<{ session: { id: string; expiresAt?: string }; token: string }>(
      base,
      `/api/orgs/${orgId}/arturita/session`,
      { token, method: 'POST', body: JSON.stringify({ source: 'desk' }) },
    ).then((r) => r.token),

  // ─── CC-ATT: extract an attached document's text (mirrors the web) ────────
  // The SAME two-step contract the web Command Center uses
  // (web/app/dashboard/AssistantPanel.tsx → pickAttachment): the file is posted
  // as multipart to /arturita/attachments/extract, the backend parses it with
  // the existing officeparser path, and only the extracted TEXT comes back. The
  // document itself is never stored, and never reaches /converse.
  //
  // Extraction happens on PICK, not on send — so an unreadable file (a scan with
  // no text layer) is reported while the operator is still choosing it, rather
  // than after they've typed a question and hit Send.
  //
  // `uri` is the local file URI from expo-document-picker. React Native's FormData
  // takes this {uri,name,type} shape and streams the file itself; the document's
  // bytes never pass through JS, and NOTHING here logs its content.
  extractAttachment: (
    base: string,
    token: string,
    orgId: string,
    file: { uri: string; name: string; mimeType?: string | null },
  ) => {
    const form = new FormData()
    // The field name is `file` — what the route's `req.file()` reads.
    form.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? 'application/octet-stream',
    } as any)
    return api<{
      attachment: { name: string; text: string; truncated: boolean }
      bytes?: number
      chars?: number
      truncated: boolean
    }>(base, `/api/orgs/${orgId}/arturita/attachments/extract`, { token, method: 'POST', body: form })
  },

  // ─── MOB-7a: speech → text, on the HOSTED leg ─────────────────────────────
  // POST /api/orgs/:orgId/arturita/transcribe — the route MOB-5a added for exactly
  // this caller (backend/src/routes/arturita-stt.ts says so at the top). The web
  // reaches Whisper on 127.0.0.1:8790; a phone can reach no loopback but its own,
  // so the hosted route IS the phone's only capture path.
  //
  // The multipart field MUST be `file` (STT_AUDIO_FIELD) — the route rejects any
  // other fieldname with a 400 rather than guessing. `voice.test.ts` pins
  // RECORDING_MIME to the route's ACCEPTED_AUDIO_MIMES so a clip can't 415.
  //
  // The audio never touches a log here, and the backend holds it in memory for the
  // provider call only (AUDIO_RETENTION, PRD §7.8). The TRANSCRIPT is user content:
  // it goes to the composer, never to a log sink.
  //
  // Errors carry a `code` the caller diagnoses through `voice.ts` — notably 503
  // `not_configured`, which means no STT key is set on the deployment yet.
  transcribe: (
    base: string,
    token: string,
    orgId: string,
    clip: { uri: string; name: string; mimeType: string },
  ) => {
    const form = new FormData()
    // RN's FormData streams the file from `uri`; the bytes never pass through JS.
    form.append('file', { uri: clip.uri, name: clip.name, type: clip.mimeType } as any)
    return api<{ transcript: string; text: string; provider?: string; bytes?: number }>(
      base,
      `/api/orgs/${orgId}/arturita/transcribe`,
      { token, method: 'POST', body: form },
    )
  },

  converse: (
    base: string,
    token: string,
    orgId: string,
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    // CC-ATT: the document attached to THIS turn, already extracted to text. The
    // backend fences it into this turn's prompt only — it never enters history,
    // so it can't re-enter (and re-bill) later turns.
    attachment?: { name: string; text: string; truncated: boolean },
    // MOB-7b: the photo attached to THIS turn, as RAW base64 (no `data:` prefix).
    // Unlike a document there is no extract round-trip — pixels have no text to
    // extract — so it rides the turn itself and reaches the model as an image
    // block. Held for the request only: never stored, never in history.
    image?: { name: string; mediaType: string; data: string },
  ) =>
    api<ConverseResult>(base, `/api/orgs/${orgId}/arturita/converse`, {
      token,
      method: 'POST',
      body: JSON.stringify({
        message,
        history: history.slice(-CONVERSE_HISTORY_LIMIT),
        deferAnswer: false,
        ...(attachment ? { attachment } : {}),
        ...(image ? { image } : {}),
      }),
    }),

  // ─── Push token registration (MOB-3) ──────────────────────────────────────
  // The backend register endpoint is USER-scoped, not org-scoped, and takes the
  // identity from the body `userId` (NOT from the bearer): it stores the token in
  // an in-memory `pushTokens: Map<userId, Set<expoToken>>` (backend
  // services/push.ts) and later POSTs to Expo's push service, targeting
  // `org.ownerId`. So `userId` MUST be the signed-in user's Clerk id (the `sub`
  // claim) for pushes to actually arrive — which equals `org.ownerId` for the
  // operator/owner. We still send `Authorization: Bearer` for consistency with
  // every other call and to be forward-compatible if the endpoint later adds a
  // gate; the endpoint currently ignores it. NEVER log `expoToken`.
  registerPush: (base: string, userId: string, expoToken: string, bearer?: string | null) =>
    api<{ ok: boolean }>(base, '/api/notifications/register', {
      token: bearer ?? undefined,
      method: 'POST',
      body: JSON.stringify({ userId, token: expoToken }),
    }),

  unregisterPush: (base: string, userId: string, expoToken: string, bearer?: string | null) =>
    api<{ ok: boolean }>(base, '/api/notifications/register', {
      token: bearer ?? undefined,
      method: 'DELETE',
      body: JSON.stringify({ userId, token: expoToken }),
    }),

  // ─── MOB-7d — the agent-settings EDITOR (owner-gated writes) ───────────────
  // Every route below is `requireOrgRole('owner')` on the backend (the SAME
  // owner-gated, field-allow-listed, validated routes the web's agent-detail tabs
  // call — NOT the legacy unvalidated `PATCH /api/agents/:id`). The phone offers
  // them only to an org owner (auth `orgRole`), and the backend 403 is the real
  // enforcer. Bodies are built by agentEdit.ts so the client validates a form the
  // same way the server will. NONE of these send or surface a secret.

  // PUT …/config — identity + adapter + primary model. Mirrors ConfigurationTab.
  updateAgentConfig: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    body: Record<string, unknown>,
  ) =>
    api<{ agent: Agent }>(base, `/api/orgs/${orgId}/agents/${agentId}/config`, {
      token,
      method: 'PUT',
      body: JSON.stringify(body),
    }).then((r) => r.agent),

  // PUT …/model-profile — primary/cheap model + reasoning effort. A model swap
  // changes spend + capability, so the screen CONFIRMS before calling this.
  // The route answers `{ agentId, profile, resolved }` — NOT `{ agent }` (the web
  // re-loads the roster after this call rather than reading the body). Return the
  // authoritative `profile` so the screen reconciles the row from the server's
  // answer; reading a non-existent `.agent` here yielded `undefined` and blanked
  // the agent on a SUCCESSFUL save (audit MOB-7d fix).
  updateModelProfile: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    body: { primaryModel: string; cheapModel: string; cheapModelEnabled: boolean; reasoningEffort: string },
  ) =>
    api<{
      agentId: string
      profile: { primaryModel: string | null; cheapModel: string | null; cheapModelEnabled: boolean; reasoningEffort: string | null }
    }>(base, `/api/orgs/${orgId}/agents/${agentId}/model-profile`, {
      token,
      method: 'PUT',
      body: JSON.stringify(body),
    }).then((r) => r.profile),

  // PUT …/trust — the trust MODE (boundary editing stays on the desk). Safety-
  // critical, so the screen CONFIRMS before calling this. The route answers
  // `{ agentId, trustMode, boundary }` — NOT `{ agent }` — so return the new
  // `trustMode` for the screen to reconcile (same audit fix as model-profile).
  updateAgentTrust: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    body: { trustMode: string },
  ) =>
    api<{ agentId: string; trustMode: string; boundary: unknown }>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/trust`,
      { token, method: 'PUT', body: JSON.stringify(body) },
    ).then((r) => r.trustMode),

  // GET …/skills — the split payload the SkillsTab renders (member-readable).
  agentSkills: (base: string, token: string, orgId: string, agentId: string) =>
    api<SkillsPayload>(base, `/api/orgs/${orgId}/agents/${agentId}/skills`, { token }),

  // PUT …/skills — the WHOLE selection (install + uninstall are one idempotent
  // write); the server answers with the new split, which replaces the optimistic one.
  updateAgentSkills: (base: string, token: string, orgId: string, agentId: string, skills: string[]) =>
    api<SkillsPayload>(base, `/api/orgs/${orgId}/agents/${agentId}/skills`, {
      token,
      method: 'PUT',
      body: JSON.stringify({ skills }),
    }),

  // GET …/available-models — populates the Model picker. Member-readable; the phone
  // degrades to a free-text model field if this fails (as the web does).
  availableModels: (base: string, token: string, orgId: string) =>
    api<{ models: ModelOption[] }>(base, `/api/orgs/${orgId}/available-models`, { token }).then(
      (r) => r.models ?? [],
    ),

  // ─── CONN-3 — per-agent connectors (owner-gated, MASKED reads) ─────────────
  // The SAME owner-gated, org-scoped-path routes the web's ConnectorsTab (CONN-2)
  // calls, over the SAME CONN-1 contract — no backend change. Every verb is
  // `requireOrgRole('owner')` on the backend, and the LIST GET is itself owner-
  // gated, so a 403 on load = definitively not an owner (the screen renders a
  // clean owner-only note instead of a scary error). The backend is the real gate.
  //
  // NONE of these ever returns a secret: reads are the `toPublicConnector`
  // allow-list (no credential, not even a secretRef). A credential is WRITE-ONLY —
  // sent up in the POST body's `secret` field, encrypted at agent scope, and never
  // read back. NEVER log a request body that may carry `secret`.

  // GET list — the catalog × this agent's state, masked.
  agentConnectors: (base: string, token: string, orgId: string, agentId: string) =>
    api<{ connectors: PublicConnectorState[] }>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/connectors`,
      { token },
    ).then((r) => r.connectors ?? []),

  // POST — configure (create or replace). `body.config` is the NON-secret config;
  // `body.secret` (optional, write-only) is the credential, sent ONLY when the
  // operator typed one — blank keeps the stored token. Answers with the masked row.
  saveAgentConnector: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    connectorId: string,
    body: { config: Record<string, unknown>; secret?: string; useOrgConnection?: boolean },
  ) =>
    api<{ connector: PublicConnectorState }>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/connectors/${connectorId}`,
      { token, method: 'POST', body: JSON.stringify(body) },
    ).then((r) => r.connector),

  // POST …/test — a credential-free connectivity check (CONN-1 does NOT dial the
  // arbitrary MCP URL from the backend — SSRF deferred); records the attempt.
  testAgentConnector: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    connectorId: string,
  ) =>
    api<{ ok: boolean; detail?: string | null; testedAt?: string }>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/connectors/${connectorId}/test`,
      { token, method: 'POST', body: '{}' },
    ),

  // DELETE — disconnect: removes the row AND its agent-scoped secret. 204 → {}.
  deleteAgentConnector: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    connectorId: string,
  ) =>
    api<Record<string, never>>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/connectors/${connectorId}`,
      { token, method: 'DELETE' },
    ),

  // PUT …/trust — CONN-7: set the owner-only per-connector trust level
  // ('approval_required' | 'auto_write'). Answers with the masked row (the trust
  // ENUM is public; never a secret). Owner-gated on the backend (the real enforcer).
  setAgentConnectorTrust: (
    base: string,
    token: string,
    orgId: string,
    agentId: string,
    connectorId: string,
    trustLevel: 'approval_required' | 'auto_write',
  ) =>
    api<{ connector: PublicConnectorState }>(
      base,
      `/api/orgs/${orgId}/agents/${agentId}/connectors/${connectorId}/trust`,
      { token, method: 'PUT', body: JSON.stringify({ trustLevel }) },
    ).then((r) => r.connector),
}
