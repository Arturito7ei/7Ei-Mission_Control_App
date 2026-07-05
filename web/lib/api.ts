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

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const { token, ...opts } = init ?? {}
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    })
  } catch {
    // fetch rejects (TypeError) only on network-level failure
    throw new Error('Network error — backend unreachable')
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
