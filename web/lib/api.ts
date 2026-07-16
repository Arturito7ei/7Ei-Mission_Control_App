// MCA-79 — shared API client for the dashboard panels. One source of truth for
// base-URL resolution, the Clerk bearer header, and the MCA-77 error mapping
// (previously duplicated as per-panel `call` helpers).
//
// Auth follows the existing panel pattern: panels receive Clerk's `getToken`
// as a prop and pass the resolved token per call — `api(path, { token: await
// getToken(), ... })`. This module is a plain function (no hooks), so the
// token rides on the init object instead of being fetched here.

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export type ApiInit = RequestInit & { token?: string | null }

/**
 * What a rejected fetch actually means. A bare "backend unreachable" hid a real
 * bug for a week: the backend was up and the route was deployed, but its CORS
 * policy did not allow PUT/DELETE, so the browser refused to send the request
 * and fetch rejected exactly as it does when the host is down. Name the two
 * cases apart — a failed write to a reachable API is a very different bug from a
 * dead backend, and the operator should not have to open devtools to tell.
 */
export function transportError(method: string, path: string): string {
  const m = method.toUpperCase()
  const where = `${m} ${path}`
  return m === 'GET' || m === 'HEAD'
    ? `Network error — could not reach the backend (${where}). Check your connection.`
    : `Network error — the browser could not send ${where}. The backend is either unreachable or is refusing this request before it arrives (a CORS policy that does not allow ${m} does exactly this).`
}

/**
 * The headers for one call. `Content-Type: application/json` is a claim about a
 * body — so it only goes on a request that HAS one. Sending it on a bodiless
 * DELETE is what broke the avatar Remove: Fastify's JSON parser refused the
 * request before the handler ran (FST_ERR_CTP_EMPTY_JSON_BODY → a bare
 * "HTTP 400: Bad Request" that named neither the layer nor the reason).
 *
 * A FormData body is the other side of that same coin: it is NOT JSON, and the
 * browser must set `multipart/form-data` itself because only it knows the part
 * boundary. Claiming `application/json` over it produces an unparseable request
 * the server rejects before the handler — so we stay out of the way.
 */
export function apiHeaders(init?: ApiInit): Record<string, string> {
  const { token, body, headers } = init ?? {}
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body != null && !isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...((headers ?? {}) as Record<string, string>),
  }
}

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const { token, ...opts } = init ?? {}
  const method = (opts.method ?? 'GET').toUpperCase()
  let res: Response
  try {
    res = await fetch(`${API}${path}`, { ...opts, headers: apiHeaders(init) })
  } catch {
    // fetch rejects (TypeError) on network-level failure AND on a blocked
    // preflight — the browser gives JS no way to tell them apart.
    throw new Error(transportError(method, path))
  }
  if (res.status === 204) return {} as T
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Some endpoints (plugin manifest validation) return an `errors` array.
    const errs = (j as any)?.errors
    const detail = (Array.isArray(errs) && errs.length ? errs.join('; ') : undefined) ?? (j as any)?.error
    let msg = `HTTP ${res.status}: ${detail ?? (res.statusText || 'Request failed')}`
    if (res.status === 401 || res.status === 403) msg += ' — token invalid or revoked. Use Replace token.'
    throw new Error(msg)
  }
  return j as T
}
