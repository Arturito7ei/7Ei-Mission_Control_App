// Epic CONN / CONN-8a — the GitHub connector EXECUTOR (the first real provider adapter).
//
// A fixed-surface executor consumed by the CONN-8a execution framework
// (services/connector-execution.ts). It maps a small set of GitHub actions to real
// api.github.com calls, using the agent-scoped `GITHUB_TOKEN` credential the framework
// hands it at execution time. Every action's declared class MUST equal
// `classifyConnectorAction('github', action)` (CONN-7 taxonomy) — asserted in tests, so
// the executor can never drift from the authorization policy.
//
// SSRF is closed by construction: the host is HARDCODED to api.github.com and every URL
// is built from that constant plus validated, encoded path segments. Params never
// supply a URL, and owner/repo are restricted to a safe charset so a segment can't
// escape the path. The credential is read from `ctx.secrets.GITHUB_TOKEN`, used only in
// the Authorization header, and never returned or logged.

import { ConnectorProviderError, type ConnectorExecutor, type ExecutorContext, type HttpClient } from './connector-execution'

const GITHUB_API = 'https://api.github.com' // HARDCODED — the ONLY host this executor dials

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/          // GitHub login rules (no dots/slashes)
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/                        // repo name charset (no slashes)
const MAX_TITLE = 400
const MAX_BODY = 65_536

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

function requireRepo(params: Record<string, unknown>): { owner: string; repo: string } {
  const owner = str(params.owner)
  const repo = str(params.repo)
  if (!OWNER_RE.test(owner)) throw new ConnectorProviderError('invalid or missing `owner`')
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') throw new ConnectorProviderError('invalid or missing `repo`')
  return { owner, repo }
}

function requireIssueNumber(params: Record<string, unknown>): number {
  const n = Number(params.number)
  if (!Number.isInteger(n) || n <= 0 || n > 1e9) throw new ConnectorProviderError('invalid or missing issue `number`')
  return n
}

function requireToken(secrets: Record<string, string>): string {
  const t = secrets.GITHUB_TOKEN
  if (!t || !t.trim()) throw new ConnectorProviderError('GitHub credential is not available')
  return t
}

/** Build a URL from the hardcoded host + validated, encoded segments. `path` MUST start
 *  with '/'. No caller ever passes a full URL — this is the SSRF boundary. */
function ghUrl(path: string): string {
  return `${GITHUB_API}${path}`
}

async function ghRequest(
  http: HttpClient,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': '7ei-mission-control',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  let payload: string | undefined
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

  const res = await http(ghUrl(path), { method, headers, body: payload })
  if (!res.ok) {
    // Surface ONLY the provider's short `message` field, truncated — never the raw body
    // (which could carry echoed request data), never the token.
    let message = ''
    try { message = String((await res.json())?.message ?? '') } catch { /* non-JSON error body */ }
    message = message.slice(0, 200)
    throw new ConnectorProviderError(`GitHub request failed (${res.status})${message ? `: ${message}` : ''}`, res.status)
  }
  if (res.status === 204) return { ok: true } // e.g. DELETE returns no content
  try { return await res.json() } catch { return null }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
// Each `class` MUST match classifyConnectorAction('github', <key>) — the taxonomy is
// the single source of truth; connector-github.test.ts asserts the alignment.

async function repoGet(ctx: ExecutorContext): Promise<unknown> {
  const { owner, repo } = requireRepo(ctx.params)
  return ghRequest(ctx.http, requireToken(ctx.secrets), 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
}

async function issuesList(ctx: ExecutorContext): Promise<unknown> {
  const { owner, repo } = requireRepo(ctx.params)
  const state = ['open', 'closed', 'all'].includes(str(ctx.params.state)) ? str(ctx.params.state) : 'open'
  return ghRequest(ctx.http, requireToken(ctx.secrets), 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=30`)
}

async function issueGet(ctx: ExecutorContext): Promise<unknown> {
  const { owner, repo } = requireRepo(ctx.params)
  const number = requireIssueNumber(ctx.params)
  return ghRequest(ctx.http, requireToken(ctx.secrets), 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`)
}

async function issueCreate(ctx: ExecutorContext): Promise<unknown> {
  const { owner, repo } = requireRepo(ctx.params)
  const title = str(ctx.params.title)
  if (!title) throw new ConnectorProviderError('`title` is required to create an issue')
  if (title.length > MAX_TITLE) throw new ConnectorProviderError('`title` is too long')
  const body = str(ctx.params.body).slice(0, MAX_BODY)
  return ghRequest(ctx.http, requireToken(ctx.secrets), 'POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, { title, ...(body ? { body } : {}) })
}

async function issueComment(ctx: ExecutorContext): Promise<unknown> {
  const { owner, repo } = requireRepo(ctx.params)
  const number = requireIssueNumber(ctx.params)
  const body = str(ctx.params.body)
  if (!body) throw new ConnectorProviderError('`body` is required to comment')
  return ghRequest(ctx.http, requireToken(ctx.secrets), 'POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, { body: body.slice(0, MAX_BODY) })
}

async function repoDelete(ctx: ExecutorContext): Promise<unknown> {
  const { owner, repo } = requireRepo(ctx.params)
  return ghRequest(ctx.http, requireToken(ctx.secrets), 'DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
}

export const githubExecutor: ConnectorExecutor = {
  connectorId: 'github',
  actions: {
    // READ — allowed freely by CONN-7.
    'repo.get': { class: 'read', handler: repoGet },
    'issues.list': { class: 'read', handler: issuesList },
    'issue.get': { class: 'read', handler: issueGet },
    // WRITE — needs approval unless the (agent,github) pair is trusted (auto_write).
    'issue.create': { class: 'write', handler: issueCreate },
    'issue.comment': { class: 'write', handler: issueComment },
    // DESTRUCTIVE — ALWAYS needs approval, even when trusted.
    'repo.delete': { class: 'destructive', handler: repoDelete },
  },
}
