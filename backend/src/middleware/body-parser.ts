// JSON body parsing for the browser-facing API.
//
// Extracted from index.ts for the same reason `cors.ts` was: a transport-layer
// default broke a working route and looked like an application bug.
//
// Fastify's built-in `application/json` parser rejects a request that declares
// that content type but carries no body — FST_ERR_CTP_EMPTY_JSON_BODY, HTTP 400
// "Body cannot be empty when content-type is set to 'application/json'". The
// dashboard's shared client sets `Content-Type: application/json` on EVERY
// request, so a bodiless write (the avatar Remove, a DELETE with nothing to
// send) never reached its handler: it 400'd in the parser and surfaced as a
// bare "HTTP 400: Bad Request" with no hint of which layer refused it.
//
// A bodiless JSON request is not malformed — there is nothing to parse and the
// handler wants nothing. It parses to `{}`. Genuinely broken JSON still fails,
// with a message that says what is wrong.
import type { FastifyInstance } from 'fastify'

/** Parse a JSON payload the way the API should: empty → `{}`, invalid → 400. */
export function parseJsonBody(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (e) {
    return { ok: false, error: `Invalid JSON body: ${(e as Error).message}` }
  }
}

/**
 * Replace Fastify's `application/json` parser with the tolerant one above.
 * Register BEFORE any route, so every scope inherits it.
 */
export function registerJsonBodyParser(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const parsed = parseJsonBody(typeof body === 'string' ? body : body.toString('utf8'))
    if (parsed.ok === false) {
      const err = new Error(parsed.error) as Error & { statusCode?: number }
      err.statusCode = 400
      return done(err, undefined)
    }
    done(null, parsed.value)
  })
}
