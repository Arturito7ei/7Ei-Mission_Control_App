// Epic H / H1 — stage the Mission Control mesh for the desktop shell.
//
// Two jobs:
//   1. Build the Next.js UI as a STANDALONE server (DESKTOP_BUILD=1) with the
//      loopback backend origin baked in (NEXT_PUBLIC_API_URL), then repair the
//      standalone tree (copy .next/static + public next to server.js — Next does
//      not do this itself) and record where server.js landed.
//   2. COMPILE the Fastify backend to a single runnable ESM file with esbuild
//      (H1: no more shipping `tsx` + the whole dev toolchain + TS source), and
//      install ONLY the runtime deps that cannot be bundled (native/wasm addons)
//      as a pruned production node_modules beside it, into build-stage/ for
//      electron-builder's extraResources.
//
// `--stage-only` builds just the web standalone (for `npm run desktop` dev mode,
// where main.cjs runs the backend straight from the repo via tsx) and skips the
// backend compile + copy into build-stage/.
//
// Why esbuild + a two-package external list (H0 → H1):
//   H0 shipped `backend/src` + the ENTIRE `backend/node_modules` (incl. tsx,
//   typescript, drizzle-kit) and forked it with `--import tsx` → a 619 MB .app.
//   H1 bundles the server + its pure-JS deps (fastify, drizzle-orm, @clerk/*,
//   zod, @anthropic-ai/sdk, redis, …) into one tree-shaken `index.js`, and keeps
//   external ONLY the two packages that carry native/wasm payloads that must load
//   from a real filesystem path and cannot be bundled:
//     • @libsql/client  → @libsql/darwin-arm64/*.node   (the DB native addon)
//     • officeparser    → tesseract.js/pdfjs-dist/@napi-rs/canvas (OCR/PDF wasm)
//   Those two are re-installed as a minimal, PINNED, prod-only node_modules so the
//   transitive closure (incl. the platform natives) is exact and complete.

import { execSync } from 'node:child_process'
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')
const WEB_DIR = path.join(REPO_ROOT, 'web')
const BACKEND_DIR = path.join(REPO_ROOT, 'backend')
const STANDALONE = path.join(WEB_DIR, '.next', 'standalone')
const STAGE = path.join(DESKTOP_DIR, 'build-stage')

const BACKEND_PORT = 8787
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`

// The only backend runtime deps that MUST stay external (native/wasm payloads
// that load from a real path and cannot be bundled). Everything else is bundled.
const BACKEND_EXTERNALS = ['@libsql/client', 'officeparser']

const stageOnly = process.argv.includes('--stage-only')

function log(msg) { console.log(`\x1b[35m[stage]\x1b[0m ${msg}`) }

function run(cmd, cwd, env = {}) {
  log(`$ ${cmd}  (cwd=${path.relative(REPO_ROOT, cwd) || '.'})`)
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
}

function findFile(dir, name, depth) {
  if (depth < 0) return null
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name)
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules') {
      const r = findFile(path.join(dir, e.name), name, depth - 1)
      if (r) return r
    }
  }
  return null
}

function copyDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: true, dereference: true })
}

/** Read a package's version from its on-disk package.json (many packages block
 *  the `./package.json` subpath in `exports`, so `require(pkg/package.json)`
 *  throws — read the file directly instead). */
function installedVersion(pkg) {
  const p = path.join(BACKEND_DIR, 'node_modules', pkg, 'package.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')).version
}

// ── 1. Build the standalone Next UI ──────────────────────────────────────────
function buildWeb() {
  log('building Next.js standalone (DESKTOP_BUILD=1)…')
  run('npm run build', WEB_DIR, {
    DESKTOP_BUILD: '1',
    NEXT_PUBLIC_API_URL: BACKEND_ORIGIN,
    // Ensure no Clerk key leaks in from a local env — the packaged UI degrades
    // to no-auth (the H6 gap). Clerk builds fine keyless (see web/Dockerfile).
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
  })

  const serverJs = findFile(STANDALONE, 'server.js', 5)
  if (!serverJs) throw new Error('standalone server.js not found after build')
  const serverDir = path.dirname(serverJs)
  const rel = path.relative(STANDALONE, serverJs)
  log(`standalone server.js → ${rel}`)

  // Next does NOT copy static assets into standalone — do it, next to server.js.
  const staticSrc = path.join(WEB_DIR, '.next', 'static')
  const staticDst = path.join(serverDir, '.next', 'static')
  if (fs.existsSync(staticSrc)) { copyDir(staticSrc, staticDst); log('copied .next/static') }
  const publicSrc = path.join(WEB_DIR, 'public')
  const publicDst = path.join(serverDir, 'public')
  if (fs.existsSync(publicSrc)) { copyDir(publicSrc, publicDst); log('copied public/') }

  // Record where server.js is so the shell can find it (monorepo nesting).
  fs.writeFileSync(
    path.join(STANDALONE, 'desktop-web-manifest.json'),
    JSON.stringify({ serverJs: rel, builtFor: BACKEND_ORIGIN }, null, 2),
  )
  return rel
}

// ── 2. Compile + stage the backend into build-stage/ ─────────────────────────
async function stageBackend() {
  const dst = path.join(STAGE, 'backend')
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(dst, { recursive: true })

  // (a) Bundle the server + its pure-JS deps into ONE runnable ESM file.
  log('compiling backend → single ESM bundle (esbuild)…')
  // A banner supplies a real Node `require`/`__dirname`/`__filename` so any
  // bundled CJS dep that reaches for them at runtime resolves correctly, and the
  // externals below resolve against the pruned node_modules we install in (b).
  const banner = [
    'import{createRequire as __cr}from"module";',
    'import{fileURLToPath as __ftp}from"url";',
    'import{dirname as __dn}from"path";',
    'const require=__cr(import.meta.url);',
    'const __filename=__ftp(import.meta.url);',
    'const __dirname=__dn(__filename);',
  ].join('')
  const result = await esbuild.build({
    entryPoints: [path.join(BACKEND_DIR, 'src', 'index.ts')],
    outfile: path.join(dst, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: BACKEND_EXTERNALS,
    banner: { js: banner },
    logLevel: 'warning',
    metafile: true,
  })
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
  log(`bundled index.js → ${(bytes / 1e6).toFixed(1)} MB`)

  // (b) A minimal, prod-only, PINNED runtime package.json → install just the
  //     externals so their native/wasm transitive closure ships intact.
  const runtimePkg = {
    name: 'mission-control-backend-runtime',
    version: '0.6.0',
    private: true,
    type: 'module',
    main: 'index.js',
    dependencies: Object.fromEntries(
      BACKEND_EXTERNALS.map((p) => [p, installedVersion(p)]),
    ),
  }
  fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify(runtimePkg, null, 2))
  log(`installing pruned runtime deps: ${Object.entries(runtimePkg.dependencies).map(([k, v]) => `${k}@${v}`).join(', ')}`)
  run('npm install --omit=dev --no-audit --no-fund --prefer-offline', dst)
}

function stageWeb() {
  const dst = path.join(STAGE, 'web')
  fs.rmSync(dst, { recursive: true, force: true })
  log('staging web standalone…')
  copyDir(STANDALONE, dst)
}

// ── main ─────────────────────────────────────────────────────────────────────
buildWeb()
if (!stageOnly) {
  fs.mkdirSync(STAGE, { recursive: true })
  await stageBackend()
  stageWeb()
  log(`staged → ${path.relative(REPO_ROOT, STAGE)}`)
}
log('done.')
