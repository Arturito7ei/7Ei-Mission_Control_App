// Epic H / H0 spike — stage the Mission Control mesh for the desktop shell.
//
// Two jobs:
//   1. Build the Next.js UI as a STANDALONE server (DESKTOP_BUILD=1) with the
//      loopback backend origin baked in (NEXT_PUBLIC_API_URL), then repair the
//      standalone tree (copy .next/static + public next to server.js — Next does
//      not do this itself) and record where server.js landed.
//   2. Stage backend/ (source + node_modules incl. tsx + the libSQL native addon)
//      and the standalone web build into build-stage/ for electron-builder's
//      extraResources.
//
// `--stage-only` builds just the web standalone (for `npm run desktop` dev mode,
// where main.cjs runs the backend straight from the repo) and skips the copy into
// build-stage/. Native modules are shipped as-is; H1 replaces the wholesale
// node_modules copy with a compiled + pruned backend bundle.

import { execSync } from 'node:child_process'
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

// ── 2. Stage backend + web into build-stage/ ─────────────────────────────────
function stageBackend() {
  const dst = path.join(STAGE, 'backend')
  fs.rmSync(dst, { recursive: true, force: true })
  log('staging backend (src + node_modules + tsx + libSQL native)…')
  for (const item of ['src', 'package.json', 'tsconfig.json', 'node_modules']) {
    const src = path.join(BACKEND_DIR, item)
    if (fs.existsSync(src)) copyDir(src, path.join(dst, item))
  }
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
  stageBackend()
  stageWeb()
  log(`staged → ${path.relative(REPO_ROOT, STAGE)}`)
}
log('done.')
