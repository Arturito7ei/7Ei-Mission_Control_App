// Epic CONN / CONN-8b-3 — the custom-MCP connector EXECUTOR (the RISKIEST adapter).
//
// Unlike every other executor, the MCP server address is USER-CONFIGURED (an arbitrary
// `url` in the connector's non-secret config), so this is a real SSRF / egress surface —
// not a fixed provider host. Consumed by the CONN-8a execution framework
// (services/connector-execution.ts) and gated by CONN-7 exactly like the others; this file
// adds only (1) the open-ended tool-invocation dispatch, (2) the opaque-tool escalation,
// and (3) a hardened, DNS-pinning, private-range-blocking HTTP transport.
//
// The three containment pillars (all fail-CLOSED):
//
//  1. TRANSPORT: only `http`-transport MCP servers can execute in v1. `stdio` (spawning a
//     local command) is arbitrary host command execution — a large, dangerous surface that
//     is DELIBERATELY not implemented here; a stdio-configured connector fails closed with a
//     clear message and is deferred to a later, carefully-audited stage.
//
//  2. OPAQUE-TOOL ESCALATION (CONN-7 carry-forward ii, generalized): an MCP tool name is
//     opaque — we cannot know a third-party tool's real effect. So `classifyConnectorAction`
//     treats it as WRITE by default (destructive-named → destructive → ALWAYS approval), and
//     `escalateAllowToApproval` escalates ANY otherwise-allowed tool (read- OR write-classified)
//     that the operator has NOT explicitly allow-listed to needs_approval — so neither
//     `auto_write` nor a read-looking name can blanket-approve an arbitrary tool. Only tools on
//     the per-connector `autoApproveTools` allow-list may auto-run under `auto_write`. The one
//     built-in exception is the framework-implemented `tools.list` meta-read (below).
//
//  3. SSRF / EGRESS (the crux — the URL is user-supplied): the configured `url` is validated
//     at execution (https-only, no embedded userinfo, literal private IPs rejected) and the
//     actual connection uses a node:https transport whose custom DNS `lookup` resolves the
//     host, REFUSES if ANY resolved address is a private / loopback / link-local / ULA /
//     cloud-metadata range, and PINS the connection to exactly the validated address (so a
//     DNS-rebinding answer cannot swap a public IP for an internal one between check and
//     connect). Redirects are NOT followed (a 3xx is an error), and the response is bounded
//     by a timeout + a size cap. See docs/DESIGN-per-agent-connectors.md §CONN-8b-3.
//
// The credential (the optional bearer stored in `CONNECTOR_MCP_SECRET`) is used ONLY as the
// Authorization header to the configured server, and the framework's redaction backstop
// covers it — it is never logged, returned, or persisted.

import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import {
  ConnectorProviderError, EXECUTION_TIMEOUT_MS, MAX_RESPONSE_BYTES,
  type ConnectorExecutor, type ExecutorContext, type HttpClient, type HttpResponse,
} from './connector-execution'
import { connectorSecretKey } from './agent-connectors'

const MCP_SECRET_KEY = connectorSecretKey('mcp') // 'CONNECTOR_MCP_SECRET'
const MAX_JSONRPC_PARAM_BYTES = 256 * 1024        // bound the request body we send upstream

// ─── 1. Private / internal address blocking (the SSRF core) ────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = ((n << 8) | v) >>> 0
  }
  return n >>> 0
}

function inCidr(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)
  if (b === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (n & mask) === (b & mask)
}

/** Is this dotted IPv4 in a private / internal / non-routable range we must never dial? */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true // unparseable → fail closed
  return (
    inCidr(n, '0.0.0.0', 8) ||        // "this" network / 0.0.0.0
    inCidr(n, '10.0.0.0', 8) ||       // private
    inCidr(n, '100.64.0.0', 10) ||    // CGNAT (RFC 6598)
    inCidr(n, '127.0.0.0', 8) ||      // loopback
    inCidr(n, '169.254.0.0', 16) ||   // link-local — INCLUDES 169.254.169.254 (cloud metadata)
    inCidr(n, '172.16.0.0', 12) ||    // private
    inCidr(n, '192.0.0.0', 24) ||     // IETF protocol assignments
    inCidr(n, '192.168.0.0', 16) ||   // private
    inCidr(n, '198.18.0.0', 15) ||    // benchmarking
    inCidr(n, '224.0.0.0', 4) ||      // multicast
    inCidr(n, '240.0.0.0', 4)         // reserved (incl. 255.255.255.255 broadcast)
  )
}

/** Is this IPv6 a loopback / unspecified / ULA / link-local / multicast, OR an IPv4-mapped
 *  address whose embedded IPv4 is itself blocked? Fail-closed on any ambiguity. */
function isBlockedIpv6(ip: string): boolean {
  const a = ip.toLowerCase().split('%')[0] // strip any zone id
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible — validate the embedded v4.
  const dottedMapped = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dottedMapped) return isBlockedIpv4(dottedMapped[1])
  const hexMapped = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16)
    return isBlockedIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
  }
  if (a === '::1' || a === '::') return true       // loopback / unspecified
  if (/^f[cd]/.test(a)) return true                 // fc00::/7 unique-local
  if (/^fe[89ab]/.test(a)) return true              // fe80::/10 link-local
  if (/^ff/.test(a)) return true                    // ff00::/8 multicast
  return false
}

/** The single address predicate: true if this resolved IP must NOT be dialed. A value
 *  that is not a valid IP is blocked (fail closed). Exported for direct unit testing. */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) return isBlockedIpv4(ip)
  if (fam === 6) return isBlockedIpv6(ip)
  return true
}

// ─── 2. URL shape validation (synchronous, no DNS) ─────────────────────────────
//
// net.connect does NOT invoke the custom lookup for an IP-literal host, so a literal
// private IP must be caught HERE (the DNS-pinning lookup only guards hostnames).

export type UrlShape = { ok: true; url: string; host: string } | { ok: false; error: string }

export function validateMcpUrlShape(rawUrl: unknown): UrlShape {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!raw) return { ok: false, error: 'MCP server url is not configured' }
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, error: 'MCP server url is invalid' } }
  if (u.protocol !== 'https:') {
    return { ok: false, error: 'MCP server url must use https (http egress is blocked in this version)' }
  }
  if (u.username || u.password) {
    return { ok: false, error: 'MCP server url must not embed credentials (userinfo)' }
  }
  const host = u.hostname
  if (!host) return { ok: false, error: 'MCP server url has no host' }
  // URL.hostname keeps the brackets on an IPv6 literal ([::1]) — strip them for the IP check.
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  // A literal-IP host is validated synchronously — it is the ONE case the pinning lookup
  // never sees. A hostname is deferred to the pinning lookup at connect time.
  if (isIP(bareHost) && isBlockedAddress(bareHost)) {
    return { ok: false, error: 'MCP server url points at a blocked private/internal address' }
  }
  return { ok: true, url: u.toString(), host }
}

// ─── 3. DNS-pinning, private-range-blocking node:https transport ───────────────

/** A dns.lookup-shaped function (injectable for tests). Resolves ALL addresses. */
export type DnsLookupAll = (
  hostname: string,
  options: { all: true; verbatim: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void,
) => void

/**
 * Build a lookup function for node:https `options.lookup`. It resolves EVERY address the
 * hostname maps to, REFUSES if ANY is a blocked private/internal range, and returns only
 * validated addresses — so the value validated is the value connected (no DNS-rebinding
 * TOCTOU: net.connect uses exactly what this returns, it does not re-resolve). Exported for
 * direct unit testing with a mock resolver.
 */
export function makeGuardedLookup(resolver: DnsLookupAll = dnsLookup as unknown as DnsLookupAll) {
  return (hostname: string, options: any, callback: any): void => {
    const cb = typeof options === 'function' ? options : callback
    const wantAll = !!(options && typeof options === 'object' && options.all)
    resolver(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err)
      const list = Array.isArray(addresses) ? addresses : []
      if (list.length === 0) return cb(new Error(`no addresses for ${hostname}`))
      for (const a of list) {
        if (isBlockedAddress(a.address)) {
          return cb(new ConnectorProviderError('MCP server host resolves to a blocked private/internal address'))
        }
      }
      if (wantAll) return cb(null, list)
      cb(null, list[0].address, list[0].family)
    })
  }
}

/**
 * The production MCP transport: a node:https client (matching the framework's HttpClient
 * contract) that PINS DNS via the guarded lookup, does NOT follow redirects (a 3xx is an
 * error — equivalent to boundedHttpClient's redirect:'error'), enforces a hard timeout, and
 * caps the response size. boundedHttpClient (global fetch) is intentionally NOT used for MCP:
 * fetch cannot pin the resolved IP, so it cannot defend against DNS rebinding.
 */
export function createMcpHttpsClient(resolver?: DnsLookupAll): HttpClient {
  const guardedLookup = makeGuardedLookup(resolver)
  return (url, init) => new Promise<HttpResponse>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    let req: ReturnType<typeof httpsRequest>
    try {
      req = httpsRequest(url, {
        method: init.method,
        headers: init.headers,
        lookup: guardedLookup as any,
        timeout: EXECUTION_TIMEOUT_MS,
      }, (res) => {
        const status = res.statusCode ?? 0
        // Do NOT follow redirects — a 3xx to an internal host is the classic SSRF pivot.
        if (status >= 300 && status < 400) {
          res.destroy(); req.destroy()
          return done(() => reject(new ConnectorProviderError(`MCP server returned a redirect (${status}) — not followed`, status)))
        }
        // Enforce the size cap up front on an honest content-length…
        const declared = Number(res.headers['content-length'] ?? '')
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          res.destroy(); req.destroy()
          return done(() => reject(new ConnectorProviderError(`MCP server response exceeds ${MAX_RESPONSE_BYTES} bytes`)))
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (c: Buffer) => {
          total += c.length
          // …and again on the materialized body (a lying/absent length can't bypass it).
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy(); req.destroy()
            return done(() => reject(new ConnectorProviderError(`MCP server response exceeds ${MAX_RESPONSE_BYTES} bytes`)))
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8')
          done(() => resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => bodyText,
            json: async () => { try { return JSON.parse(bodyText) } catch { return null } },
          }))
        })
        res.on('error', () => done(() => reject(new ConnectorProviderError('MCP server response failed'))))
      })
    } catch {
      return done(() => reject(new ConnectorProviderError('MCP server request failed')))
    }
    req.on('timeout', () => { req.destroy(); done(() => reject(new ConnectorProviderError(`MCP server request timed out after ${EXECUTION_TIMEOUT_MS}ms`))) })
    req.on('error', (e: any) => {
      // A blocked-address rejection from the guarded lookup surfaces here — keep its message.
      const msg = e instanceof ConnectorProviderError ? e.message : 'MCP server request failed'
      done(() => reject(new ConnectorProviderError(msg)))
    })
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

// ─── 4. The MCP JSON-RPC call (over the http transport) ────────────────────────

function mcpConfig(ctx: ExecutorContext): { url: string } {
  const cfg = ctx.config ?? {}
  const transport = typeof cfg.transport === 'string' ? cfg.transport : 'http'
  if (transport !== 'http') {
    throw new ConnectorProviderError('stdio MCP execution not yet supported — only http-transport MCP servers can execute in this version')
  }
  const shape = validateMcpUrlShape(cfg.url)
  if (shape.ok !== true) throw new ConnectorProviderError(shape.error)
  return { url: shape.url }
}

async function mcpJsonRpc(ctx: ExecutorContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  const { url } = mcpConfig(ctx)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Streamable-HTTP MCP servers may return either JSON or an SSE stream; we consume JSON.
    Accept: 'application/json',
  }
  const secret = ctx.secrets?.[MCP_SECRET_KEY]
  if (secret && secret.trim()) headers.Authorization = `Bearer ${secret.trim()}` // configured auth only

  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  if (body.length > MAX_JSONRPC_PARAM_BYTES) {
    throw new ConnectorProviderError('MCP request payload is too large')
  }

  const res = await ctx.http(url, { method: 'POST', headers, body })
  if (!res.ok) {
    // Surface ONLY the provider's short error message, truncated — never the raw body,
    // never the credential.
    let message = ''
    try { message = String((await res.json())?.error?.message ?? '') } catch { /* non-JSON */ }
    message = message.slice(0, 200)
    throw new ConnectorProviderError(`MCP server request failed (${res.status})${message ? `: ${message}` : ''}`, res.status)
  }
  const payload = await res.json()
  // A JSON-RPC-level error is a clean tool failure, not a transport failure.
  if (payload && typeof payload === 'object' && (payload as any).error) {
    const msg = String((payload as any).error?.message ?? '').slice(0, 200)
    throw new ConnectorProviderError(`MCP tool error${msg ? `: ${msg}` : ''}`)
  }
  return payload && typeof payload === 'object' && 'result' in (payload as any) ? (payload as any).result : payload
}

// ─── 5. Actions + open-ended dispatch ──────────────────────────────────────────

/** List the server's tools for display — a fixed, vetted READ meta-operation the executor
 *  itself implements (NOT an opaque server tool). Exempt from allow-list escalation. */
async function listTools(ctx: ExecutorContext): Promise<unknown> {
  return mcpJsonRpc(ctx, 'tools/list', {})
}

/** Invoke ONE opaque MCP tool: the action string IS the tool name; params ARE its args. */
async function invokeTool(action: string, ctx: ExecutorContext): Promise<unknown> {
  return mcpJsonRpc(ctx, 'tools/call', { name: action, arguments: ctx.params ?? {} })
}

/** The operator's explicit per-connector allow-list of tool names permitted to auto-run
 *  under `auto_write`. Absent / malformed → nothing is auto-approved. Pure. */
export function isMcpToolAutoApproved(action: string, config: Record<string, unknown> | null): boolean {
  const list = config?.autoApproveTools
  if (!Array.isArray(list)) return false
  return list.some(t => typeof t === 'string' && t === action)
}

/**
 * Escalation policy for the OPEN-ENDED MCP surface (supersedes mustEscalateUnknownWrite):
 * escalate ANY otherwise-allowed action to needs_approval UNLESS it is the built-in
 * `tools.list` meta-read OR the operator has explicitly allow-listed the exact tool name.
 * So `auto_write` (and a read-looking tool name) can never blanket-approve an arbitrary
 * third-party tool. Destructive-named tools never reach here — they classify as destructive
 * and always need approval regardless. Pure.
 */
export function mcpEscalateAllowToApproval(action: string, config: Record<string, unknown> | null): boolean {
  if (action === 'tools.list') return false
  return !isMcpToolAutoApproved(action, config)
}

export const mcpExecutor: ConnectorExecutor = {
  connectorId: 'mcp',
  credentialKind: 'env',
  // The ONLY fixed action: a safe, framework-implemented tools/list meta-read.
  actions: {
    'tools.list': { class: 'read', handler: listTools },
  },
  // Any other action name is an opaque tool → one JSON-RPC tools/call.
  invoke: invokeTool,
  escalateAllowToApproval: mcpEscalateAllowToApproval,
  defaultHttpClient: createMcpHttpsClient(),
}
