// Arturita Local Host — ACTION layer. Real filesystem I/O, every op gated by
// safety.decideAccess. Reads/lists/previews are safe and run freely; destructive
// ops (move/delete/overwrite) FAIL CLOSED — they require `approved === true`
// (an A2-approved backend command) and stage originals to an undo journal so a
// mistake is reversible. Fail closed on ambiguity.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decideAccess, classifyBlast } from './safety.mjs'

const MAX_READ_BYTES = 5 * 1024 * 1024   // 5 MB read cap
const UNDO_DIR = path.join(os.homedir(), '.arturita-host', 'undo')  // itself denylisted from Arturita's reach

function ensureUndoDir() { fs.mkdirSync(UNDO_DIR, { recursive: true }) }

/** List a directory (non-destructive). */
export function listDir({ target, root }) {
  const access = decideAccess({ op: 'list', target, root })
  if (!access.allowed) return { ok: false, reason: access.reason }
  const st = fs.statSync(access.real)
  if (!st.isDirectory()) return { ok: false, reason: 'not a directory' }
  const entries = fs.readdirSync(access.real, { withFileTypes: true }).map(d => {
    const full = path.join(access.real, d.name)
    let bytes = 0
    try { bytes = d.isFile() ? fs.statSync(full).size : 0 } catch {}
    return { name: d.name, dir: d.isDirectory(), bytes }
  })
  return { ok: true, path: access.real, entries }
}

/** Read a file (non-destructive; size-capped). */
export function readFile({ target, root, maxBytes = MAX_READ_BYTES }) {
  const access = decideAccess({ op: 'read', target, root })
  if (!access.allowed) return { ok: false, reason: access.reason }
  const st = fs.statSync(access.real)
  if (!st.isFile()) return { ok: false, reason: 'not a file' }
  if (st.size > maxBytes) return { ok: false, reason: `file too large (${st.size} > ${maxBytes}) — narrow the read` }
  const content = fs.readFileSync(access.real, 'utf8')
  return { ok: true, path: access.real, bytes: st.size, content }
}

/** Build a preview manifest for a destructive op WITHOUT performing it. Resolves
 *  + access-checks each target; refuses the whole op if any target is denied. */
export function preview({ op, targets, destination, root }) {
  const files = []
  for (const t of targets ?? []) {
    const access = decideAccess({ op, target: t, root })
    if (!access.allowed) return { ok: false, reason: `${t}: ${access.reason}` }
    let bytes = 0
    try { bytes = fs.statSync(access.real).size } catch {}
    files.push({ path: access.real, bytes })
  }
  if (destination) {
    const da = decideAccess({ op: 'write', target: destination, root })
    if (!da.allowed) return { ok: false, reason: `destination ${destination}: ${da.reason}` }
  }
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0)
  const blast = classifyBlast({ op, fileCount: files.length, totalBytes })
  return {
    ok: true,
    manifest: { op, fileCount: files.length, totalBytes, destination: destination ?? null, files: files.slice(0, 20), truncated: files.length > 20 },
    blast,
  }
}

/** Apply a destructive op. FAIL CLOSED: requires `approved === true`; refuses if
 *  blast radius is 'refuse'; stages originals to the undo journal. Returns an
 *  undo token. */
export function applyDestructive({ op, targets, destination, root, approved }) {
  if (approved !== true) return { ok: false, reason: 'destructive op requires an A2-approved backend command (approved!=true) — refused, fail-closed' }
  const pv = preview({ op, targets, destination, root })
  if (!pv.ok) return pv
  if (pv.blast.verdict === 'refuse') return { ok: false, reason: pv.blast.reason }

  ensureUndoDir()
  const stamp = `${process.hrtime.bigint()}`
  const staged = []
  try {
    for (const f of pv.manifest.files.length === pv.manifest.fileCount ? pv.manifest.files : resolveAll(targets, root)) {
      const src = f.path
      const stagePath = path.join(UNDO_DIR, `${stamp}-${path.basename(src)}`)
      if (op === 'delete' || op === 'overwrite' || op === 'move') {
        fs.renameSync(src, stagePath)             // move original out (reversible)
        staged.push({ original: src, staged: stagePath })
      }
      if (op === 'move' && destination) {
        const destAccess = decideAccess({ op: 'write', target: path.join(destination, path.basename(src)), root })
        fs.mkdirSync(destination, { recursive: true })
        fs.renameSync(stagePath, destAccess.real)  // place at destination
        staged[staged.length - 1].staged = null     // moved into place, not staged
        staged[staged.length - 1].placed = destAccess.real
      }
    }
  } catch (e) {
    return { ok: false, reason: `apply failed mid-op: ${e.message}`, staged }
  }
  const token = `${stamp}`
  const undoEntry = { token, op, performedAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000, staged }
  fs.writeFileSync(path.join(UNDO_DIR, `${token}.json`), JSON.stringify(undoEntry))
  return { ok: true, token, staged: staged.length, undoExpiresAt: undoEntry.expiresAt }
}

function resolveAll(targets, root) {
  const out = []
  for (const t of targets ?? []) {
    const a = decideAccess({ op: 'move', target: t, root })
    if (a.allowed) out.push({ path: a.real, bytes: 0 })
  }
  return out
}

/** Undo a prior destructive op within its window: restore staged originals. */
export function undo({ token }) {
  const p = path.join(UNDO_DIR, `${String(token || '').replace(/[^0-9a-z-]/gi, '')}.json`)
  if (!fs.existsSync(p)) return { ok: false, reason: 'unknown or expired undo token' }
  const entry = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'undo window elapsed' }
  let restored = 0
  for (const s of entry.staged) {
    try {
      if (s.placed && fs.existsSync(s.placed)) { fs.renameSync(s.placed, s.original); restored++ }
      else if (s.staged && fs.existsSync(s.staged)) { fs.renameSync(s.staged, s.original); restored++ }
    } catch {}
  }
  fs.unlinkSync(p)
  return { ok: true, restored }
}

export const _internals = { UNDO_DIR, MAX_READ_BYTES }
