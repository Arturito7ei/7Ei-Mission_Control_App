// Arturita Local Host — the daemon. A localhost-only HTTP service the backend
// calls (after auth) to inspect/act on the operator's machine. Runs as the
// operator user (no sudo), keep-alive via launchd (see setup.sh). FAIL CLOSED:
//   - binds 127.0.0.1 only (never a public interface);
//   - every request needs the shared bearer token (ARTURITA_HOST_TOKEN);
//   - reads/lists/previews are safe; destructive ops require `approved:true`
//     (an A2-approved backend command) and stage originals for undo.
//
// This is a SCAFFOLD + the real read/preview/undo path. Destructive execution is
// wired but gated behind the approval flag; machine_exec is intentionally NOT
// exposed here yet (C3, approval-gated).

import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { listDir, readFile, preview, applyDestructive, undo } from './actions.mjs'

const PORT = Number(process.env.ARTURITA_HOST_PORT || 8799)
const TOKEN = process.env.ARTURITA_HOST_TOKEN || ''
// Whole-machine root by default (S3); override to scope tighter if desired.
const ROOT = process.env.ARTURITA_HOST_ROOT || '/'

function authed(req) {
  if (!TOKEN) return false // fail closed: no token configured → nothing is authed
  const h = req.headers['authorization'] || ''
  const got = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (got.length !== TOKEN.length) return false
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN)) } catch { return false }
}

function send(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(s)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'arturita-host', root: ROOT, tokenConfigured: !!TOKEN })
    }
    if (!authed(req)) return send(res, 401, { ok: false, reason: 'unauthorized (bearer token required)' })
    if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method not allowed' })

    const body = await readBody(req)
    if (body === null) return send(res, 400, { ok: false, reason: 'invalid JSON' })
    const withRoot = (o) => ({ ...o, root: ROOT })

    try {
      switch (req.url) {
        case '/list':    return send(res, 200, listDir(withRoot(body)))
        case '/read':    return send(res, 200, readFile(withRoot(body)))
        case '/preview': return send(res, 200, preview(withRoot(body)))
        case '/apply':   return send(res, 200, applyDestructive(withRoot(body))) // needs approved:true
        case '/undo':    return send(res, 200, undo(body))
        default:         return send(res, 404, { ok: false, reason: 'unknown capability' })
      }
    } catch (e) {
      return send(res, 500, { ok: false, reason: `host error: ${e.message}` })
    }
  })
}

// Start when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!TOKEN) {
    console.error('[arturita-host] REFUSING to start: ARTURITA_HOST_TOKEN is not set (fail-closed).')
    process.exit(1)
  }
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`[arturita-host] listening on 127.0.0.1:${PORT} (root=${ROOT})`)
  })
}
