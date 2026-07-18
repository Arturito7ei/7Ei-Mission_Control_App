// CORS policy for the browser-facing API.
//
// Extracted from index.ts so it can be asserted in a test. The reason it exists
// as its own module is a bug it caused: @fastify/cors v11 defaults
// `methods` to 'GET,HEAD,POST'. Any route the dashboard reaches with PUT,
// PATCH or DELETE therefore failed its preflight in the browser — the request
// was never sent, fetch rejected, and `web/lib/api.ts` reported the transport
// failure as "Network error — backend unreachable". That is what broke the AG
// Instructions save (PUT), the avatar Remove (DELETE) and the Skills checkboxes
// (PUT), while the avatar upload (POST) kept working.
//
// The method list must therefore cover every verb the routes actually register.
// `boot.test.ts` walks the route table and fails if a verb is missing here.

/** Every HTTP verb the API exposes to a browser. */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

/**
 * Every request header a browser is allowed to send. This is a TRANSPORT
 * allowance, not an authorization decision: a header absent from this list is
 * refused by the BROWSER at preflight, so the request never reaches the route
 * and the server-side gate that reads it can never fire.
 *
 * APPR-1 audit: `x-arturita-session` (the step-up token the decide route requires
 * to approve a dangerous action — routes/tasks.ts) was missing here. The desk's
 * new step-up dialog minted a real session and then sent the decide call with the
 * header, and the browser blocked it at preflight — so the fix for "the desk
 * cannot approve a dangerous action" was itself unreachable from a browser. The
 * phone never hit this because React Native performs no CORS preflight, which is
 * exactly why mirroring the phone's contract was necessary but NOT sufficient.
 *
 * Adding it WEAKENS NOTHING: it does not change who may approve or what the
 * server verifies. It only lets the browser deliver a header the server already
 * demands. Every entry here must be a header some client genuinely sends.
 */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'x-arturita-session',
] as const

export const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8081',
  'https://7ei.ai',
  'https://app.7ei.ai',
]

export function corsOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    origin: env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) ?? DEFAULT_ORIGINS,
    methods: [...CORS_METHODS],
    // The dashboard sends the Clerk bearer token and JSON bodies; multipart
    // avatar uploads let the browser set their own Content-Type boundary. The
    // step-up token rides in `x-arturita-session` — see CORS_ALLOWED_HEADERS.
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    credentials: true,
  }
}
