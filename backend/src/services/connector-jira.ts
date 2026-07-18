// Epic CONN / CONN-8b-1 — the JIRA connector EXECUTOR (Atlassian Cloud, basic auth).
//
// A fixed-surface executor consumed by the CONN-8a execution framework
// (services/connector-execution.ts), following the GitHub executor pattern exactly. It
// maps a small set of Jira actions to real `{baseUrl}/rest/api/3/...` calls, using the
// agent-scoped `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_BASE_URL` values the framework
// hands it at execution time (they arrive via CONN-4a's CONNECTOR_ENV_KEYS['jira']).
// Every action's declared class MUST equal `classifyConnectorAction('jira', action)`
// (CONN-7 taxonomy) — asserted in tests, so the executor can never drift from policy.
//
// SSRF is closed by construction. Unlike GitHub (a single hardcoded host), Jira's host
// is per-tenant — it comes from the STORED `JIRA_BASE_URL` secret, NEVER a param. The
// stored value is nonetheless validated at EVERY execution: it must be https, carry no
// userinfo, and be an Atlassian Cloud host (`*.atlassian.net`, via CONN-4a's
// `isAtlassianHost`). We then dial ONLY that URL's ORIGIN (scheme+host), discarding any
// path/query/fragment the stored value might carry, plus validated + encoded path
// segments. A param can supply an issue key or JQL (encoded into a segment / query) but
// can NEVER supply or influence the host. The credential is used only in the
// Authorization header and is never returned or logged.

import { isAtlassianHost } from './agent-connectors'
import { ConnectorProviderError, type ConnectorExecutor, type ExecutorContext, type HttpClient } from './connector-execution'

const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ // PROJ-123 or a numeric id — no dots/slashes
const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/
const TRANSITION_ID_RE = /^[0-9]{1,18}$/
const MAX_SUMMARY = 400
const MAX_TEXT = 32_768
const MAX_JQL = 2_000

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

/**
 * Resolve the Jira ORIGIN to dial from the STORED baseUrl secret. This is the SSRF
 * boundary: the host is never param-supplied. The stored value is re-validated on every
 * call (https, no userinfo, Atlassian Cloud host) and reduced to its origin so any
 * path/query/fragment it might carry is discarded before we append our own path.
 */
function resolveJiraOrigin(secrets: Record<string, string>): string {
  const raw = str(secrets.JIRA_BASE_URL)
  if (!raw) throw new ConnectorProviderError('Jira base URL is not configured')
  let url: URL
  try { url = new URL(raw) } catch { throw new ConnectorProviderError('Jira base URL is invalid') }
  if (url.protocol !== 'https:') throw new ConnectorProviderError('Jira base URL must be https')
  if (url.username || url.password) throw new ConnectorProviderError('Jira base URL must not embed credentials')
  // Reuse CONN-4a's allow-list — Atlassian Cloud only. A self-hosted Jira is not dialed
  // (fail-closed): execution is high-consequence, so we restrict to the known host shape.
  if (!isAtlassianHost(url.origin)) throw new ConnectorProviderError('Jira base URL must be an Atlassian Cloud host')
  return url.origin // scheme + host ONLY — the fixed dialing base for this tenant
}

function basicAuth(secrets: Record<string, string>): string {
  const email = str(secrets.JIRA_EMAIL)
  const token = str(secrets.JIRA_API_TOKEN)
  if (!email || !token) throw new ConnectorProviderError('Jira credential is not available')
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
}

function requireIssueKey(params: Record<string, unknown>): string {
  const key = str(params.issueKey) || str(params.issueIdOrKey) || str(params.key)
  if (!ISSUE_KEY_RE.test(key) || key === '.' || key === '..') throw new ConnectorProviderError('invalid or missing `issueKey`')
  return key
}

/** Minimal Atlassian Document Format wrapper for a plain-text body (Jira Cloud v3). */
function adf(text: string): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] }
}

async function jiraRequest(
  http: HttpClient,
  auth: string,
  origin: string,
  method: string,
  path: string, // MUST start with '/', built from validated + encoded segments only
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: auth,
    Accept: 'application/json',
    'User-Agent': '7ei-mission-control',
  }
  let payload: string | undefined
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

  const res = await http(`${origin}${path}`, { method, headers, body: payload })
  if (!res.ok) {
    // Surface ONLY Jira's short `errorMessages`, truncated — never the raw body (which
    // could echo request data), never the credential, never the URL.
    let message = ''
    try {
      const j: any = await res.json()
      const msgs = Array.isArray(j?.errorMessages) ? j.errorMessages : []
      message = msgs.filter((m: unknown) => typeof m === 'string').join('; ').slice(0, 200)
    } catch { /* non-JSON error body */ }
    throw new ConnectorProviderError(`Jira request failed (${res.status})${message ? `: ${message}` : ''}`, res.status)
  }
  if (res.status === 204) return { ok: true } // DELETE / transition return no content
  try { return await res.json() } catch { return null }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
// Each `class` MUST match classifyConnectorAction('jira', <key>) — asserted in the test.

async function issueGet(ctx: ExecutorContext): Promise<unknown> {
  const origin = resolveJiraOrigin(ctx.secrets)
  const key = requireIssueKey(ctx.params)
  return jiraRequest(ctx.http, basicAuth(ctx.secrets), origin, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}`)
}

async function issueSearch(ctx: ExecutorContext): Promise<unknown> {
  const origin = resolveJiraOrigin(ctx.secrets)
  const jql = str(ctx.params.jql).slice(0, MAX_JQL)
  if (!jql) throw new ConnectorProviderError('`jql` is required to search')
  const max = Math.min(Math.max(Number(ctx.params.maxResults) || 25, 1), 50)
  // jql is a query PARAM, encoded — it can never influence the host or escape the path.
  return jiraRequest(ctx.http, basicAuth(ctx.secrets), origin, 'GET', `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${max}`)
}

async function issueCreate(ctx: ExecutorContext): Promise<unknown> {
  const origin = resolveJiraOrigin(ctx.secrets)
  const projectKey = str(ctx.params.projectKey)
  if (!PROJECT_KEY_RE.test(projectKey)) throw new ConnectorProviderError('invalid or missing `projectKey`')
  const summary = str(ctx.params.summary)
  if (!summary) throw new ConnectorProviderError('`summary` is required to create an issue')
  if (summary.length > MAX_SUMMARY) throw new ConnectorProviderError('`summary` is too long')
  const issueType = str(ctx.params.issueType) || 'Task'
  const description = str(ctx.params.description).slice(0, MAX_TEXT)
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary,
    issuetype: { name: issueType.slice(0, 100) },
    ...(description ? { description: adf(description) } : {}),
  }
  return jiraRequest(ctx.http, basicAuth(ctx.secrets), origin, 'POST', `/rest/api/3/issue`, { fields })
}

async function issueComment(ctx: ExecutorContext): Promise<unknown> {
  const origin = resolveJiraOrigin(ctx.secrets)
  const key = requireIssueKey(ctx.params)
  const body = str(ctx.params.body)
  if (!body) throw new ConnectorProviderError('`body` is required to comment')
  return jiraRequest(ctx.http, basicAuth(ctx.secrets), origin, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: adf(body.slice(0, MAX_TEXT)) })
}

async function issueTransition(ctx: ExecutorContext): Promise<unknown> {
  const origin = resolveJiraOrigin(ctx.secrets)
  const key = requireIssueKey(ctx.params)
  const transitionId = str(ctx.params.transitionId)
  if (!TRANSITION_ID_RE.test(transitionId)) throw new ConnectorProviderError('invalid or missing `transitionId`')
  return jiraRequest(ctx.http, basicAuth(ctx.secrets), origin, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } })
}

async function issueDelete(ctx: ExecutorContext): Promise<unknown> {
  const origin = resolveJiraOrigin(ctx.secrets)
  const key = requireIssueKey(ctx.params)
  return jiraRequest(ctx.http, basicAuth(ctx.secrets), origin, 'DELETE', `/rest/api/3/issue/${encodeURIComponent(key)}`)
}

export const jiraExecutor: ConnectorExecutor = {
  connectorId: 'jira',
  actions: {
    // READ — allowed freely by CONN-7.
    'issue.get': { class: 'read', handler: issueGet },
    'issue.search': { class: 'read', handler: issueSearch },
    // WRITE — needs approval unless the (agent,jira) pair is trusted (auto_write).
    'issue.create': { class: 'write', handler: issueCreate },
    'issue.comment': { class: 'write', handler: issueComment },
    'issue.transition': { class: 'write', handler: issueTransition },
    // DESTRUCTIVE — ALWAYS needs approval, even when trusted.
    'issue.delete': { class: 'destructive', handler: issueDelete },
  },
}
