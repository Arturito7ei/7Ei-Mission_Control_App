// Shared API client for the iPhone remote. Mirrors web/lib/api.ts: one place for
// base-URL joining, the bearer header, and error mapping — including the
// transport-error distinction (a failed write to a reachable API reads very
// differently from a dead backend). The bearer is a Clerk JWT (or, in phase-1
// token-paste mode, a Clerk session token the operator pasted).

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
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body != null ? { 'Content-Type': 'application/json' } : {}),
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

  converse: (
    base: string,
    token: string,
    orgId: string,
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
  ) =>
    api<ConverseResult>(base, `/api/orgs/${orgId}/arturita/converse`, {
      token,
      method: 'POST',
      body: JSON.stringify({ message, history: history.slice(-20), deferAnswer: false }),
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
