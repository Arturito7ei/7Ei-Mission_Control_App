// Epic H / H6 — the SINGLE-OPERATOR LOOPBACK IDENTITY for the packaged profile.
//
// Hosted authenticates every secured route with a Clerk JWT (multi-tenant). A
// packaged instance is single-tenant on 127.0.0.1 and ships NO Clerk keys, so it
// cannot use Clerk as-is. H6 replaces the Clerk identity source — and ONLY the
// identity source — with a local operator bound to the OS user:
//
//   * The Electron shell generates a per-install `MC_LOOPBACK_SESSION_SECRET` into
//     the macOS login Keychain (OS-user-bound by construction — only the logged-in
//     user's session can read it) and injects it into the backend env.
//   * `middleware/loopback-auth.ts` fills the SAME secured-scope hook Clerk fills on
//     hosted: a request presenting that secret as its bearer authenticates AS this
//     one local operator; every other request 401s. It is NOT "no auth" — a second
//     OS account / a browser tab without the injected header cannot drive the app.
//   * requireOrgMembership / requireOrgRole / the owner checks then all keep working
//     unchanged, with the local operator as OWNER of the one local org.
//
// This module owns the operator/org identifiers and the idempotent bootstrap that
// makes the operator a real OWNER of a real org, so the membership + owner gates
// have a row to resolve against exactly as they do for a hosted user.

import { db as defaultDb, schema } from '../db/client'
import { eq } from 'drizzle-orm'

/** The synthetic user id the loopback operator authenticates as. Stable + reserved:
 *  it is not a Clerk `sub` (those are `user_…`), so it can never collide with a
 *  hosted identity. Set as the local org's `ownerId` and its `org_members` row. */
export const LOCAL_OPERATOR_USER_ID = 'local-operator'

/** The one org a packaged instance runs. Fixed id so the seed is idempotent and the
 *  dashboard always resolves the same workspace across reboots. */
export const LOCAL_ORG_ID = 'local-org'
export const LOCAL_ORG_NAME = 'Local'

type BootstrapDb = Pick<typeof defaultDb, 'query' | 'insert'>

/**
 * Idempotently ensure the local operator OWNS a local org, so the packaged
 * dashboard has a workspace and the membership/owner gates have rows to resolve.
 *
 * Safe to call on every boot: it inserts the org + the owner `org_members` row only
 * when absent, and never overwrites operator-edited fields (name/mission/etc.). It
 * seeds BOTH the org (`ownerId` — the rbac grandfather source of truth) and the
 * explicit owner membership row, so `enforceOrgRole('owner')` and the surface-wide
 * `requireOrgMembership` both pass for the operator without relying on either path
 * alone. Returns the local org id for callers/logging.
 */
export async function bootstrapLocalOperator(database: BootstrapDb = defaultDb): Promise<string> {
  const existingOrg = await database.query.organisations.findFirst({
    where: eq(schema.organisations.id, LOCAL_ORG_ID),
  })
  if (!existingOrg) {
    await database.insert(schema.organisations).values({
      id: LOCAL_ORG_ID,
      name: LOCAL_ORG_NAME,
      description: 'Your local Mission Control workspace.',
      ownerId: LOCAL_OPERATOR_USER_ID,
      createdAt: new Date(),
      deployMode: 'local',
      deployConfig: {},
    })
  }

  const existingMember = await database.query.orgMembers.findFirst({
    where: eq(schema.orgMembers.orgId, LOCAL_ORG_ID),
  })
  if (!existingMember) {
    await database.insert(schema.orgMembers).values({
      id: `${LOCAL_ORG_ID}-owner`,
      orgId: LOCAL_ORG_ID,
      userId: LOCAL_OPERATOR_USER_ID,
      role: 'owner',
      createdAt: new Date(),
    })
  }

  return LOCAL_ORG_ID
}
