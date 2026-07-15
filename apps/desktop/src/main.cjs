// Epic H / H0 spike — Mission Control desktop shell (Electron main process).
//
// This is the SUPERVISOR: on launch it boots the packaged/loopback Mission
// Control mesh as ONE app —
//   1. Fastify backend, forked as a child of Electron's own Node
//      (ELECTRON_RUN_AS_NODE + `--import tsx`), MC_DEPLOYMENT_PROFILE=packaged,
//      DATABASE_URL pointed at a LOCAL libSQL FILE under Application Support,
//      idempotent migrations run on boot, bound to 127.0.0.1.
//   2. The Next.js UI, forked from its `standalone` server build, also on 127.0.0.1.
//   3. A BrowserWindow pointed at the local Next server once both are healthy.
//
// H6 (this stage) lands REAL loopback auth: per-install keys are generated into the
// macOS Keychain (SECRETS_ENC_KEY / RUN_TOKEN_SECRET / MC_LOOPBACK_SESSION_SECRET),
// the backend runs the `packaged` profile with its Clerk hook swapped for the
// single-operator loopback identity, and the shell injects that identity's bearer on
// every BrowserWindow→backend request. Still deferred: Tray (H1), TCC wizard (H2),
// auto-update (H3), config seeding (H4).
//
// Everything binds 127.0.0.1 — loopback is the trust boundary of `packaged`, and the
// injected header (never in page JS) is what makes the local operator the ONLY caller
// that can drive the secured routes.

const { app, BrowserWindow, shell, session } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { getOrCreateKey } = require('./keychain.cjs')

// ─── Fixed loopback ports (spike). H1 can make these dynamic/free-port-scan. ──
const BACKEND_PORT = 8787
const WEB_PORT = 8788
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`
const DEPLOYMENT_PROFILE = 'packaged'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Where the staged mesh payload lives: unpacked resources in a built app, the
 *  repo itself in `npm run desktop` dev mode. */
function paths() {
  if (app.isPackaged) {
    const res = process.resourcesPath
    return {
      backendDir: path.join(res, 'backend'),
      webDir: path.join(res, 'web'),
    }
  }
  return {
    backendDir: path.join(REPO_ROOT, 'backend'),
    webDir: path.join(REPO_ROOT, 'web', '.next', 'standalone'),
  }
}

/** Resolve the Next standalone `server.js`. Next nests it under the workspace-
 *  relative path inside `.next/standalone` (a monorepo gotcha), so we read the
 *  location the build/stage step recorded, then fall back to a shallow search. */
function resolveWebServer(webDir) {
  const manifest = path.join(webDir, 'desktop-web-manifest.json')
  if (fs.existsSync(manifest)) {
    try {
      const rel = JSON.parse(fs.readFileSync(manifest, 'utf8')).serverJs
      if (rel) {
        const abs = path.join(webDir, rel)
        if (fs.existsSync(abs)) return abs
      }
    } catch {}
  }
  // Fallback: check the two common locations, then a bounded walk.
  for (const cand of [path.join(webDir, 'server.js'), path.join(webDir, 'web', 'server.js')]) {
    if (fs.existsSync(cand)) return cand
  }
  const found = findFile(webDir, 'server.js', 4)
  if (found) return found
  throw new Error(`Next standalone server.js not found under ${webDir}`)
}

function findFile(dir, name, depth) {
  if (depth < 0) return null
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules') {
      const r = findFile(path.join(dir, e.name), name, depth - 1)
      if (r) return r
    }
  }
  return null
}

let backendProc = null
let webProc = null
let win = null
/** The per-install loopback session secret (from the OS Keychain). It is the bearer
 *  the shell injects on every BrowserWindow→backend request AND the secret the backend
 *  validates. Held only in the trusted main process — never exposed to page JS. */
let provisioned = null

/**
 * Generate-or-read the three per-install secrets from the macOS login Keychain
 * (H6 / AUDIT-H1 #1). Runs once per boot, before the backend starts. FAIL-CLOSED:
 * a keychain error throws — we never substitute a default, the backend's H6 boot
 * guard would refuse it anyway, and no real secret is encrypted under a throwaway.
 */
function provisionSecrets() {
  provisioned = {
    // Distinct per-install values (#1 / #4): the run-token secret is its OWN key, not
    // SECRETS_ENC_KEY reused via the agent-api fallback.
    SECRETS_ENC_KEY: getOrCreateKey('SECRETS_ENC_KEY'),
    RUN_TOKEN_SECRET: getOrCreateKey('RUN_TOKEN_SECRET'),
    MC_LOOPBACK_SESSION_SECRET: getOrCreateKey('MC_LOOPBACK_SESSION_SECRET'),
  }
  return provisioned
}

/**
 * Inject the loopback operator's bearer on every request the BrowserWindow makes to
 * the backend origin. The web UI ships no Clerk keys, so its own fetches carry no (or
 * a placeholder) Authorization header; this rewrites it to the real per-install
 * session secret. The token therefore lives ONLY in the trusted main process and the
 * loopback request — never in page JS (no XSS-readable credential) — and only requests
 * from THIS window's session get it, so a stray localhost caller cannot authenticate.
 */
function installLoopbackAuthHeader() {
  const filter = { urls: [`${BACKEND_ORIGIN}/*`] }
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    const headers = details.requestHeaders
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') delete headers[k]
    }
    if (provisioned?.MC_LOOPBACK_SESSION_SECRET) {
      headers['Authorization'] = `Bearer ${provisioned.MC_LOOPBACK_SESSION_SECRET}`
    }
    cb({ requestHeaders: headers })
  })
}
const logDir = () => {
  const d = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function pipeChild(child, tag) {
  const out = fs.createWriteStream(path.join(logDir(), `${tag}.log`), { flags: 'a' })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  child.stdout?.on('data', (b) => process.stdout.write(`[${tag}] ${b}`))
  child.stderr?.on('data', (b) => process.stderr.write(`[${tag}] ${b}`))
}

function startBackend() {
  const { backendDir } = paths()
  const dbPath = path.join(app.getPath('userData'), 'mc.db')
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MC_DEPLOYMENT_PROFILE: DEPLOYMENT_PROFILE,
    DATABASE_URL: `file:${dbPath}`,
    DATABASE_AUTH_TOKEN: '',
    HOST: '127.0.0.1',
    PORT: String(BACKEND_PORT),
    NODE_ENV: 'production',
    // H6: real per-install keys from the OS Keychain (never a default). No Clerk keys
    // → the backend swaps clerkAuth for the single-operator loopback identity, which
    // validates MC_LOOPBACK_SESSION_SECRET as the bearer. The backend's H6 boot guard
    // (assertSecretKeysSafe) REFUSES to start if any of these is missing/default.
    ...provisioned,
  }
  // H1: packaged ships a COMPILED bundle (build-stage/backend/index.js), forked
  // straight from Electron's own Node — no tsx, no TS source, no dev toolchain.
  // Dev mode (`npm run desktop`, app not packaged) still runs the repo TS source
  // via `--import tsx` for parity + fast iteration; cwd is the backend dir either
  // way so the pruned native deps (@libsql/client, officeparser) resolve.
  const args = app.isPackaged
    ? [path.join(backendDir, 'index.js')]
    : ['--import', 'tsx', path.join(backendDir, 'src', 'index.ts')]
  console.log(`[shell] backend: DB=${dbPath} profile=${DEPLOYMENT_PROFILE} → ${BACKEND_ORIGIN} (${app.isPackaged ? 'compiled' : 'tsx/dev'})`)
  backendProc = spawn(process.execPath, args, {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeChild(backendProc, 'backend')
  backendProc.on('exit', (code) => console.log(`[shell] backend exited: ${code}`))
}

function startWeb() {
  const { webDir } = paths()
  const serverJs = resolveWebServer(webDir)
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(WEB_PORT),
    // The loopback backend origin was baked into the build (NEXT_PUBLIC_API_URL),
    // but pass it at runtime too for any server-side reads.
    NEXT_PUBLIC_API_URL: BACKEND_ORIGIN,
  }
  console.log(`[shell] web: ${serverJs} → ${WEB_ORIGIN}`)
  webProc = spawn(process.execPath, [serverJs], {
    cwd: path.dirname(serverJs),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeChild(webProc, 'web')
  webProc.on('exit', (code) => console.log(`[shell] web exited: ${code}`))
}

/** Poll a URL until it answers 2xx, or reject after `timeoutMs`. */
function waitForHttp(url, { timeoutMs = 45000, expectJsonOk = false } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          const ok2xx = res.statusCode >= 200 && res.statusCode < 300
          if (ok2xx && (!expectJsonOk || /"status"\s*:\s*"ok"/.test(body))) return resolve(body)
          retry()
        })
      })
      req.on('error', retry)
      req.setTimeout(3000, () => req.destroy())
    }
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`))
      setTimeout(tick, 500)
    }
    tick()
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: '7Ei Mission Control (packaged)',
    backgroundColor: '#0b0b0d',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // Open external links (the landing's sign-in etc.) in the system browser, not
  // inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(WEB_ORIGIN)) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })
  win.loadFile(path.join(__dirname, 'loading.html'))
  return win
}

async function boot() {
  createWindow()
  // Provision per-install keys + install the loopback auth header BEFORE anything
  // starts, so the backend boots with real keys and every window→backend request
  // carries the operator bearer. A keychain failure throws → the catch shows an error.
  provisionSecrets()
  installLoopbackAuthHeader()
  startBackend()
  startWeb()
  try {
    await waitForHttp(`${BACKEND_ORIGIN}/api/health`, { expectJsonOk: true })
    console.log('[shell] backend healthy ✓ (packaged profile, local file DB, loopback auth)')
    await waitForHttp(`${WEB_ORIGIN}/`)
    console.log('[shell] web UI up ✓')
    // H6: land on the authenticated DASHBOARD as the local operator. The web build is
    // packaged-flagged (NEXT_PUBLIC_MC_PACKAGED=1) so the dashboard renders without a
    // Clerk sign-in, and the shell-injected bearer authenticates every API call.
    await win.loadURL(WEB_ORIGIN + '/dashboard')
  } catch (err) {
    console.error('[shell] boot failed:', err)
    const msg = String(err && err.message ? err.message : err).replace(/`/g, "'")
    await win.loadURL(
      'data:text/html,' + encodeURIComponent(
        `<body style="font-family:system-ui;background:#0b0b0d;color:#eee;padding:40px">
         <h2>Mission Control failed to boot</h2><pre>${msg}</pre>
         <p>Logs: ${logDir()}</p></body>`,
      ),
    )
  }
}

function shutdown() {
  for (const p of [backendProc, webProc]) {
    if (p && !p.killed) { try { p.kill('SIGTERM') } catch {} }
  }
}

app.whenReady().then(boot)
app.on('window-all-closed', () => { shutdown(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', shutdown)
app.on('quit', shutdown)
process.on('exit', shutdown)
