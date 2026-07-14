// Epic ONB / ONB2 — LOG REDACTION at the persistence boundary (audit finding H2).
//
// ONB2 serves the first TOKEN-ADDRESSED route: `/api/agent-invites/<mci_inv_…>/onboarding.txt`.
// The invite token in that path is a bearer credential — it is the thing that decides
// who may ask to join — and `middleware/audit-log.ts` persists `req.url` verbatim into
// `audit_logs.path`. Without this module the first doc fetch writes a working invite
// link, in plaintext, into a queryable table — exactly what the hash-only storage of
// `agent_invites.token_hash` exists to prevent (a DB read must yield no working links).
//
// So: every credential-shaped PATH SEGMENT is replaced with `:token` BEFORE anything
// is persisted or logged. Applied in both sinks (the audit table and Fastify's request
// logger), because a token in a log is a token in a log.
//
// PURE: string in, string out. No I/O, no env.

/**
 * Credential shapes this system actually mints, plus the two upstream ones we
 * carry. Anchored (`^…$`) and matched against a WHOLE path segment, so a normal
 * path can never be mangled into `:token` by accident.
 *
 *   mci_inv_*  invite token           (ONB1 — this route's bearer)
 *   mca_*      agent API token        (agent-token.ts — never in a path today; belt)
 *   art_*      Arturita session token (arturita-session.ts — same)
 *   mcc_*      reserved for the ONB4 one-time claim secret, so ONB4 inherits this
 *              redaction for free rather than re-deriving it.
 */
const TOKEN_SEGMENT_PATTERNS: RegExp[] = [
  /^mci_inv_[0-9a-zA-Z]{8,}$/,
  /^mca_[0-9a-zA-Z]{8,}$/,
  /^art_[0-9a-zA-Z]{8,}$/,
  /^mcc_[0-9a-zA-Z]{8,}$/,
]

/** Is this single path segment a credential we mint? */
export function isTokenSegment(segment: string): boolean {
  return TOKEN_SEGMENT_PATTERNS.some((re) => re.test(segment))
}

/**
 * Redact credential-shaped segments out of a URL/path before it is persisted or logged.
 *
 * `/api/agent-invites/mci_inv_ab…/onboarding.txt` → `/api/agent-invites/:token/onboarding.txt`
 *
 * The query string is dropped entirely (the audit log already did this — restated
 * here so the ONE function is the whole boundary and a caller cannot forget half of it).
 */
export function redactPath(url: string | null | undefined): string {
  const raw = String(url ?? '')
  const path = raw.split('?')[0].split('#')[0]
  return path
    .split('/')
    .map((seg) => (isTokenSegment(seg) ? ':token' : seg))
    .join('/')
}

/**
 * Redact credential-shaped substrings anywhere in a free-text string (an error
 * message, a URL echoed into a body). Complements `redactPath`, which only walks
 * path segments — an exception like `GET https://host/api/agent-invites/mci_inv_… failed`
 * is one string, not a path.
 */
export function redactTokensInText(text: string | null | undefined): string {
  return String(text ?? '').replace(/\b(mci_inv_|mca_|art_|mcc_)[0-9a-zA-Z]{8,}\b/g, '$1[REDACTED]')
}
