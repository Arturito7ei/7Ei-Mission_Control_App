// ─── GC-0b — THE CLASS-LEVEL GUARD ───────────────────────────────────────────
//
// Six routes in this codebase shipped the same defect: a request body written into a
// row without a field allow-list. Fixing six instances does not close a CLASS — the
// seventh lands the moment someone writes the same three lines again, and nothing in
// CI notices. This file is the thing that notices.
//
// It statically scans every route module for row-write sinks and classifies the
// argument each one passes:
//
//   • an INLINE OBJECT LITERAL — `.set({ status, kanbanColumn })` — is self-evidently
//     an allow-list: the fields are named right there. Always allowed.
//   • anything else — a variable, a cast, a spread, `req.body` — is opaque at this
//     level, so it must be named in REVIEWED_SINKS below with a one-line justification.
//
// A NEW opaque sink therefore fails this test until a human writes down why it is safe.
// That is the point: the cost of adding instance #7 becomes "explain yourself in a
// test file", which is exactly the review step that was missing all six times.
//
// It is deliberately a source scan rather than a behavioural test. The class is a
// SHAPE, and a behavioural test can only ever cover routes someone remembered to
// write a test for — which is, again, the failure mode.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTES_DIR = new URL('../routes/', import.meta.url).pathname

/**
 * Opaque (non-literal) row-write sinks that a human has reviewed.
 *
 * KEY   — `<file>:<argument expression as written>`
 * VALUE — why it is not mass assignment.
 *
 * Add an entry ONLY after checking that the value is built from a field allow-list
 * (a zod schema, an explicit key loop, or a hard-coded object), NOT from a request
 * body that merely had a few keys deleted. A deny-list is what this test exists to
 * stop: it is how `PATCH /api/agents/:agentId` shipped a member-settable `trustMode`.
 */
const REVIEWED_SINKS: Record<string, string> = {
  // ── The six GC-0 / GC-0b allow-lists ──────────────────────────────────────
  'projects.ts:patch': 'GC-0: ProjectPatchSchema — zod allow-list, orgId/id/createdAt absent.',
  'tasks.ts:patch': 'GC-0b: GoalPatchSchema / TaskPatchSchema / workspace + watchdog patches — zod or explicit-key allow-lists.',
  'skills.ts:patch': 'GC-0b: SkillPatchSchema — zod allow-list; global skills refused outright.',
  'agents.ts:body': 'GC-0b: AgentPatchSchema — zod allow-list; every owner-gated field absent.',
  'orgs.ts:patch': 'GC-0b: OrgPatchSchema — zod allow-list; credentials/budget/ownerId absent.',

  // ── Pre-existing, verified allow-listed builders ──────────────────────────
  'agent-detail.ts:result.fields': 'validateConfigPatch (services/agent-config.ts) iterates CONFIG_FIELDS; unknown keys never copied.',
  'agents.ts:patch': 'Owner-gated trust/model-profile routes; `patch` is built key-by-key from validated input.',
  'agents.ts:patch.set as any': 'buildModelProfilePatch (services/model-profile.ts) returns a fixed 4-key object.',
  'agents.ts:rollbackPatch': 'Config rollback: explicit 12-key allow-list, plus an in-handler enforceOrgRole(owner).',
  'webhooks.ts:update': 'Built key-by-key from validated fields; id/orgId never assigned.',
  'scheduled.ts:update': 'Built key-by-key from validated fields; id/orgId never assigned.',
  'arturita.ts:result.patch!': 'parseBindingPatch returns a fixed-key object; orgId comes from the path.',
  'arturita.ts:plan.agentPatch': 'Planner-built, fixed-key agent patch; no request body reaches it.',
  'arturita-wallet.ts:row as any': 'zod PolicyBody parse; orgId taken from the path, not the body.',
  'agent-connectors.ts:patch': 'Built key-by-key from validated connector config; agentId/orgId from the path.',
  'agent-auth-google.ts:patch': 'OAuth callback writes server-derived token fields only; no client body.',
  'agent-api.ts:patch': 'Agent-token scope; built key-by-key and re-checked against the agent\'s own org.',
  'tasks.ts:result.patch!': 'Approval decide: server-derived decision fields (status/decidedBy/decidedAt).',
  'tasks.ts:patch as any': 'PATCH /api/watchdogs/:id — single-key allow-list (`enabled`, boolean-checked); nothing else copied.',
}

/** `.set(` / `.values(` sinks whose argument is an inline object literal are fine. */
const SINK_RE = /\.(set|values)\(\s*([^\n]*)/g

/** Extract a stable key for the argument expression a sink receives. */
function argKey(rest: string): { literal: boolean; key: string } {
  const trimmed = rest.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return { literal: true, key: '' }
  // Strip a trailing `)` / `.where(...)` tail and any `as any` cast noise, but KEEP
  // the cast in the key when present — a cast is exactly the thing worth reviewing.
  const m = trimmed.match(/^([A-Za-z_$][\w$.!]*(?:\s+as\s+any)?)/)
  return { literal: false, key: m ? m[1].replace(/\s+/g, ' ') : trimmed.slice(0, 40) }
}

function scan() {
  const offenders: string[] = []
  const unreviewed: string[] = []
  for (const file of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf-8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      // Comments describing the defect are not the defect.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      // Only DB write sinks; `map.set(...)`, `searchParams.set(...)`, `new Set(...)`
      // and cache `.set(` are not row writes.
      if (!/db\.(update|insert)\(/.test(line) && !/^\s*(await\s+)?db\./.test(line)) return
      SINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SINK_RE.exec(line))) {
        const { literal, key } = argKey(m[2])
        if (literal) continue
        // The hard ban: the exact shape all six instances had.
        if (/^req\.body|^body\b/.test(key) && !REVIEWED_SINKS[`${file}:${key}`]) {
          offenders.push(`${file}:${i + 1}  →  .${m[1]}(${key})`)
          continue
        }
        // SCOPE OF THE REVIEW REGISTRY: `.set()` (UPDATE) only.
        //
        // The class is an UPDATE that rewrites an existing row's tenant column — that
        // is what defeats the gate, because the gate authorises the PRE-IMAGE. An
        // INSERT cannot rewrite a pre-image: every create route in this repo takes
        // `orgId` from the `:orgId` PATH and names its columns explicitly
        // (`{ id: randomUUID(), orgId, …}`), so the ~40 `.values(row)` sinks are the
        // house pattern rather than the defect, and demanding a registry entry for
        // each would bury the signal that makes this test worth keeping.
        // An INSERT that spreads a request body is still caught — by the raw-body ban
        // above, which applies to both sinks.
        if (m[1] === 'set' && !REVIEWED_SINKS[`${file}:${key}`]) {
          unreviewed.push(`${file}:${i + 1}  →  .${m[1]}(${key})`)
        }
      }
    })
  }
  return { offenders, unreviewed }
}

test('[GC-0b] no route writes a raw request body into a row (the mass-assignment class)', () => {
  const { offenders } = scan()
  assert.deepEqual(offenders, [],
    'MASS ASSIGNMENT: a route writes `req.body` / `body` straight into a row.\n' +
    'This is the GC-0 / GC-0b vulnerability class — six routes shipped it and two were\n' +
    'Critical. The membership gate CANNOT defend it: `resolveRequestOrg` derives the org\n' +
    'FROM THE ROW and evaluates it BEFORE the handler mutates that row, so any writable\n' +
    'tenant column walks straight past the gate.\n' +
    'FIX: a zod ALLOW-LIST of the writable columns (see ProjectPatchSchema in\n' +
    'routes/projects.ts for the exemplar). Do NOT use a deny-list — deleting a few keys\n' +
    'is how PATCH /api/agents/:agentId shipped a member-settable `trustMode`.\n' +
    'Offenders:\n  ' + offenders.join('\n  '))
})

test('[GC-0b] every opaque row-write sink is reviewed and justified', () => {
  const { unreviewed } = scan()
  assert.deepEqual(unreviewed, [],
    'UNREVIEWED ROW-WRITE SINK: a route writes a non-literal value into a row, and\n' +
    'nobody has recorded why that value is safe.\n' +
    'This is not necessarily a bug — but it is the exact shape the GC-0 class hides in,\n' +
    'so it needs one line of human review before it merges.\n' +
    'ACTION: confirm the value is built from a field ALLOW-LIST (a zod schema, an\n' +
    'explicit key loop, or a hard-coded object) and not from a request body with a few\n' +
    'keys deleted, then add it to REVIEWED_SINKS in this file with the reason.\n' +
    'Unreviewed:\n  ' + unreviewed.join('\n  '))
})

test('[GC-0b] the guard actually bites — a planted offender is detected', () => {
  // A guard that has never been seen to fail is a guard nobody knows works. This
  // exercises the real classifier against the real defect shape, and against the
  // DENY-LIST variant too — because a deny-list is what five of the six looked like
  // to a casual reader, and it must not read as safe here.
  const rawBody = argKey('req.body as any).where(eq(schema.tasks.id, taskId))')
  assert.equal(rawBody.literal, false, 'a raw `req.body` sink was classified as an inline literal')
  assert.match(rawBody.key, /^req\.body/, 'the raw-body sink was not recognised')
  assert.equal(REVIEWED_SINKS[`tasks.ts:${rawBody.key}`], undefined,
    'a raw `req.body` sink must never be pre-approved in REVIEWED_SINKS')

  const denyList = argKey('patchAfterDeletingOneKey).where(eq(schema.agents.id, id))')
  assert.equal(denyList.literal, false, 'a deny-list variable sink was classified as an inline literal')
  assert.equal(REVIEWED_SINKS[`agents.ts:${denyList.key}`], undefined,
    'an unknown sink must not be silently accepted')

  // And the converse: a genuine inline allow-list must NOT be flagged, or the guard
  // is noise and the next person deletes it.
  assert.equal(argKey('{ status, kanbanColumn }).where(eq(schema.tasks.id, id))').literal, true,
    'an inline allow-list literal was flagged — the guard would be too noisy to keep')
})
