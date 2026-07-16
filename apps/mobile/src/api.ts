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
  llmProvider?: string | null
  llmModel?: string | null
  heartbeatStatus?: string | null
  trustMode?: string | null
}

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
  ) =>
    api<ConverseResult>(base, `/api/orgs/${orgId}/arturita/converse`, {
      token,
      method: 'POST',
      body: JSON.stringify({
        message,
        history: history.slice(-CONVERSE_HISTORY_LIMIT),
        deferAnswer: false,
        ...(attachment ? { attachment } : {}),
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
}
