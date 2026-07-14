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
    // avatar uploads let the browser set their own Content-Type boundary.
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  }
}
