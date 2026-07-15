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

  decideApproval: (
    base: string,
    token: string,
    id: string,
    decision: 'approved' | 'rejected' | 'revision_requested',
    note?: string,
  ) =>
    api<{ approval: Approval }>(base, `/api/approvals/${id}/decide`, {
      token,
      method: 'POST',
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    }),

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
}
