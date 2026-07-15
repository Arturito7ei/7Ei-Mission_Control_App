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
// It is deliberately minimal (a DE-RISK spike): no Tray (H1), no TCC wizard (H2),
// no auto-update (H3), no config seeding (H4), no real loopback auth (H6). The
// packaged profile here has an auth BYPASS (no Clerk keys) — it is NOT security-
// complete; H6 builds the single-operator loopback identity.
//
// Everything binds 127.0.0.1 — loopback is the trust boundary of `packaged`.

const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

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
    // TEMPORARY (H0/H1): no Clerk keys → the backend's clerkPlugin is skipped
    // (auth BYPASS) and tenant routes 401 without a token. This is NOT security-
    // complete: H6 lands real single-operator loopback identity + fail-closed-on-
    // default-key. Do NOT treat this key as a secret.
    SECRETS_ENC_KEY: process.env.SECRETS_ENC_KEY || 'h0-spike-local-only-not-secure',
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
  startBackend()
  startWeb()
  try {
    await waitForHttp(`${BACKEND_ORIGIN}/api/health`, { expectJsonOk: true })
    console.log('[shell] backend healthy ✓ (packaged profile, local file DB)')
    await waitForHttp(`${WEB_ORIGIN}/`)
    console.log('[shell] web UI up ✓')
    // Land on the marketing/landing route: it renders without Clerk (the packaged
    // auth path is H6). The dashboard needs loopback auth and is out of scope here.
    await win.loadURL(WEB_ORIGIN + '/')
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
