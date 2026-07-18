// GC-0b (audit) — the CREATE-side half of the mass-assignment class.
//
// The PATCH half of the class was about a body-writable TENANT COLUMN: write `orgId`
// and the row walks out of its tenant, past a gate that authorised the pre-image.
//
// This is the other half, and it hides better. On a create route `orgId` comes from the
// PATH — correct, gate-checked, obviously safe — and that is exactly what makes the
// body-supplied FOREIGN KEY next to it look harmless. It is not, when the referenced
// row carries AUTHORITY:
//
//     POST /api/orgs/ORG-A/tasks  { "agentId": "<an agent in ORG B>" }
//
// The task is correctly created in org A. Then `executeAgentTask` resolves the agent BY
// ID ALONE and treats `agent.orgId` as ambient authority — org B's LLM credentials,
// budget, knowledge base and connectors — while the output lands in a row org A reads.
// Nothing ever compared the two orgs, because no single route ever held both facts in
// a form that looked like a tenancy question.
//
// So: any route that accepts an org-scoped foreign key FROM THE BODY must assert the
// referenced row lives in the org the request is scoped to. This module is the one
// named way to do that. It exists as a shared helper rather than three hand-rolled
// `if` blocks for two reasons: the check reads identically everywhere, and — the real
// point — a STATIC GUARD can look for the marker. See
// `src/tests/gc0b-mass-assignment-guard.test.ts`, which fails any route handler that
// reads a body-supplied agent id without calling one of these.
//
// This is the ergonomic layer: it 400s at CREATE so the bad row never exists and the
// operator gets a real message. The AUTHORITATIVE layer is in `executeAgentTask`, which
// refuses to run a task whose agent is in a different org than the task — because the
// invariant belongs to execution, not to any one entry point. Keep both.

import { eq } from 'drizzle-orm'
import { db as defaultDb, schema } from '../db/client'

/**
 * Assert that `agentId` names an agent belonging to `orgId`.
 *
 * Returns `null` when the reference is fine, or the error message to send with a 400.
 * (A message-or-null rather than a tagged union so call sites read as one line and
 * need no type narrowing: `const err = await assertAgentInOrg(...); if (err) return …`.)
 *
 * Fails closed on a MISSING agent as well as a foreign one, and deliberately does not
 * distinguish the two in the message: "no such agent" vs "not your agent" is an
 * existence oracle across tenants.
 *
 * Pass `null`/`undefined` for an absent optional field and it is a no-op success, so
 * call sites can invoke it unconditionally.
 */
export async function assertAgentInOrg(
  agentId: string | null | undefined,
  orgId: string,
  database: Pick<typeof defaultDb, 'query'> = defaultDb,
): Promise<string | null> {
  if (agentId == null) return null
  const agent = await database.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  if (!agent || agent.orgId !== orgId) {
    return 'Invalid agentId: not an agent in this organisation'
  }
  return null
}
