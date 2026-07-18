import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'

// Regression guard for the bug that broke the Agents pages in production:
// @fastify/cors v11 defaults `methods` to 'GET,HEAD,POST'. The AG routes are
// PUT (Instructions save, Skills selection, Config) and DELETE (avatar remove,
// file delete), so the browser's preflight was answered with an
// Access-Control-Allow-Methods that did not list the verb, the real request was
// never sent, and the dashboard surfaced it as "Network error — backend
// unreachable". The routes themselves were fine and deployed.
//
// These tests exercise the actual preflight, not the options object, so a future
// upgrade that changes the default cannot reintroduce the failure silently.

import { CORS_METHODS, CORS_ALLOWED_HEADERS, DEFAULT_ORIGINS, corsOptions } from '../middleware/cors'
import { agentDetailRoutes } from '../routes/agent-detail'

const ORIGIN = 'https://app.7ei.ai'

async function appWithCors(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  const app = Fastify({ logger: false })
  await app.register(cors, corsOptions(env))
  await app.register(agentDetailRoutes)
  await app.ready()
  return app
}

/**
 * The probe defaults to asking for EVERY header the clients actually send, not a
 * hardcoded pair.
 *
 * This helper previously hardcoded 'authorization,content-type', and that is
 * precisely why the whole suite stayed green while `x-arturita-session` was
 * undeliverable: the probe never asked for the header that was missing, so there
 * was nothing for it to fail on. A probe that cannot express the failure is not a
 * guard. Callers may still pass an explicit list to test a specific case.
 */
const preflight = (
  app: Awaited<ReturnType<typeof appWithCors>>,
  method: string,
  url: string,
  requestHeaders: readonly string[] = CORS_ALLOWED_HEADERS,
) =>
  app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': requestHeaders.join(',').toLowerCase(),
    },
  })

/** The headers a preflight response actually grants, lower-cased. */
const grantedHeaders = (res: { headers: Record<string, unknown> }): string[] =>
  String(res.headers['access-control-allow-headers'] ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

test('[AGFIX1] preflight allows every verb the dashboard uses', async () => {
  const app = await appWithCors()
  const cases: [string, string][] = [
    ['PUT', '/api/orgs/o1/agents/a1/files'],       // BUG 1 — Instructions save
    ['DELETE', '/api/orgs/o1/agents/a1/avatar'],   // BUG 2 — avatar remove
    ['PUT', '/api/orgs/o1/agents/a1/skills'],      // Skills checkboxes
    ['PUT', '/api/orgs/o1/agents/a1/config'],
    ['PUT', '/api/orgs/o1/agents/a1/budget'],
    ['DELETE', '/api/orgs/o1/agents/a1/files'],
    ['POST', '/api/orgs/o1/agents/a1/avatar'],     // upload — worked before, must keep working
  ]

  for (const [method, url] of cases) {
    const res = await preflight(app, method, url)
    assert.ok(res.statusCode < 300, `${method} ${url}: preflight status ${res.statusCode}`)
    const allowed = String(res.headers['access-control-allow-methods'] ?? '')
      .split(',').map(s => s.trim().toUpperCase())
    assert.ok(allowed.includes(method), `${method} ${url}: allow-methods was "${allowed.join(',')}"`)
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN)
    // BOTH AXES, every case. The method bug (AGFIX1) and the header bug (APPR-1)
    // are the same failure wearing different clothes: an explicit allow-list that
    // silently omits something a client sends, answered with a 204 the browser
    // then refuses to act on. Checking only one axis per test is how the second
    // one went unnoticed for a whole story, so every case now checks both.
    const granted = grantedHeaders(res)
    for (const h of CORS_ALLOWED_HEADERS) {
      assert.ok(granted.includes(h.toLowerCase()),
        `${method} ${url}: the browser may not send "${h}" — granted "${granted.join(',')}"`)
    }
  }
  await app.close()
})

test('[AGFIX1] CORS_METHODS covers every verb the agent routes register', async () => {
  const app = Fastify({ logger: false })
  const seen = new Set<string>()
  app.addHook('onRoute', r => {
    for (const m of ([] as string[]).concat(r.method as string | string[])) seen.add(m.toUpperCase())
  })
  await app.register(agentDetailRoutes)
  await app.ready()

  const allowed = new Set<string>(CORS_METHODS)
  for (const m of seen) {
    assert.ok(allowed.has(m), `route verb ${m} is registered but missing from CORS_METHODS — the browser cannot call it`)
  }
  // Sanity: the guard is only meaningful if it actually saw the verbs at issue.
  assert.ok(seen.has('PUT') && seen.has('DELETE'))
  await app.close()
})

// ─── APPR-1 audit — the step-up header must survive preflight ────────────────
//
// The method bug above has an exact twin in the header axis: `allowedHeaders` is
// an EXPLICIT list, so any custom header not named in it is refused by the
// browser at preflight and the real request is never sent. Approving a dangerous
// action from the desk requires `x-arturita-session` (routes/tasks.ts), so
// omitting it made the entire web step-up flow unreachable from a browser while
// every unit test passed — the phone was immune only because React Native does
// no preflight.
//
// Note the `preflight()` helper above hardcodes 'authorization,content-type'.
// That is why no existing test caught this: the probe never asked for the header
// that was missing. These tests ask for the real thing.

test('[APPR-1] preflight allows the x-arturita-session step-up header', async () => {
  const app = await appWithCors()
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/orgs/o1/agents/a1/files',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-arturita-session',
    },
  })
  assert.ok(res.statusCode < 300, `preflight status ${res.statusCode}`)
  const allowed = String(res.headers['access-control-allow-headers'] ?? '')
    .split(',').map(s => s.trim().toLowerCase())
  assert.ok(
    allowed.includes('x-arturita-session'),
    'REGRESSION: the browser may not send x-arturita-session, so approving a dangerous ' +
      'action from the desk fails at preflight — the request never reaches the step-up ' +
      `gate. Allow-Headers was "${allowed.join(',')}".`,
  )
  await app.close()
})

test('[APPR-1] every header a client actually sends is in CORS_ALLOWED_HEADERS', () => {
  // Guards REMOVAL of the three known headers. (Authorization / Content-Type are
  // not custom, so the source scan below cannot see them — this covers them.)
  for (const h of ['Authorization', 'Content-Type', 'x-arturita-session']) {
    assert.ok(
      (CORS_ALLOWED_HEADERS as readonly string[]).some(x => x.toLowerCase() === h.toLowerCase()),
      `${h} is sent by a client but missing from CORS_ALLOWED_HEADERS`,
    )
  }
})

test('[APPR-1] no client sends a custom header the browser would be refused', () => {
  // The check above is a hand-maintained list, so it catches a header being
  // REMOVED from the allowance but NOT a client starting to send a new one —
  // which is the direction this bug actually travelled. This one closes that:
  // it reads the client sources and requires every custom (`x-…`) header literal
  // to be allowed at preflight.
  //
  // Read as TEXT, never imported: web/ and apps/mobile/ are separate workspaces
  // and the backend CI job installs only backend/ — an import would fail there
  // while passing locally. The `x-` convention is what makes this low-noise;
  // a non-`x-` custom header would need adding to the list above by hand.
  const roots = ['../../../web/lib', '../../../web/app', '../../../apps/mobile/src']
  const found = new Set<string>()
  const walk = (dir: string) => {
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue
        walk(p)
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/['"](x-[a-zA-Z0-9-]+)['"]/g)) {
          found.add(m[1].toLowerCase())
        }
      }
    }
  }
  for (const r of roots) walk(fileURLToPath(new URL(r, import.meta.url)))

  // The scan must actually see something, or it is a guard that can never fire.
  assert.ok(found.has('x-arturita-session'),
    'the scan found no x-arturita-session in any client — it is not looking where the clients live')

  const allowed = new Set((CORS_ALLOWED_HEADERS as readonly string[]).map(h => h.toLowerCase()))
  const unallowed = [...found].filter(h => !allowed.has(h))
  assert.deepEqual(unallowed, [],
    `a client sends custom header(s) the browser will refuse at preflight: ${unallowed.join(', ')}. ` +
      'Add them to CORS_ALLOWED_HEADERS — otherwise the request never leaves the browser and the ' +
      'failure surfaces as a generic "Network error", not as the missing-header bug it is.')
})

test('[AGFIX1] allowed origins come from ALLOWED_ORIGINS, trimmed', () => {
  assert.deepEqual(corsOptions({} as NodeJS.ProcessEnv).origin, DEFAULT_ORIGINS)
  const o = corsOptions({ ALLOWED_ORIGINS: 'https://a.7ei.ai, https://b.7ei.ai' } as NodeJS.ProcessEnv)
  assert.deepEqual(o.origin, ['https://a.7ei.ai', 'https://b.7ei.ai'])
})

test('[AGFIX1] an origin that is not allow-listed gets no CORS grant', async () => {
  const app = await appWithCors()
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/orgs/o1/agents/a1/files',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
  })
  assert.equal(res.headers['access-control-allow-origin'], undefined)
  await app.close()
})
