// Epic CONN / CONN-5 — redirect-URI safety for the per-agent OAuth flow.
//
// TWO redirects exist in the flow, and neither may become an OPEN REDIRECT:
//   1. Google's `redirect_uri` — ALWAYS our own callback (`${PUBLIC_URL}${PATH}`),
//      never client-supplied. It is a constant in agent-google-auth.ts.
//   2. The POST-callback bounce back into the web dashboard. The ONLY safe targets
//      are our own allow-listed web origins (ALLOWED_ORIGINS). We never accept an
//      arbitrary return URL from the client; we pick a validated origin and append a
//      fixed dashboard path + status query. This module is the gate.

/** The configured web origins (ALLOWED_ORIGINS, comma-separated). Pure over env. */
export function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Resolve a SAFE origin for the post-callback bounce. If `preferred` is one of the
 * allow-listed origins, use it; otherwise fall back to the first allow-listed origin;
 * if none is configured, return null (the caller then returns a plain JSON result
 * instead of redirecting). NEVER returns an origin that isn't explicitly allow-listed,
 * so a forged `redirect_origin` in a state row can't create an open redirect. Pure.
 */
export function allowedRedirectOrigin(preferred?: string | null): string | null {
  const origins = allowedOrigins()
  if (origins.length === 0) return null
  if (preferred) {
    const norm = stripTrailingSlash(preferred)
    const match = origins.find(o => stripTrailingSlash(o) === norm)
    if (match) return stripTrailingSlash(match)
  }
  return stripTrailingSlash(origins[0])
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * Build the final dashboard redirect URL: a validated origin + a FIXED path +
 * a status query (`google=connected|error`, plus the agent id so the tab can route).
 * Only status/agent go in the query — never a token. Returns null if no safe origin.
 */
export function dashboardRedirect(
  origin: string | null,
  params: { google: 'connected' | 'error'; agentId?: string; reason?: string },
): string | null {
  if (!origin) return null
  const q = new URLSearchParams()
  q.set('google', params.google)
  if (params.agentId) q.set('agent', params.agentId)
  if (params.reason) q.set('reason', params.reason)
  return `${origin}/dashboard?${q.toString()}`
}
