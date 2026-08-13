// The org row's public projection. ONE place, because a per-route allow-list
// drifts and this table carries live credentials.
//
// WHY THIS EXISTS. `GET /api/orgs` was `db.select().from(organisations)` — the
// WHOLE row — and the `organisations` table carries TWO credentials:
//
//   • `telegramBotToken` — a live bot token.
//   • `deployConfig`     — a JSON blob of LLM API keys. Org creation writes
//     `deployConfig[`${provider}_api_key`] = body.llmApiKey` in PLAINTEXT
//     (routes/orgs.ts), and the executor still reads that legacy plaintext key
//     alongside the newer AES-256-GCM `<slug>_api_key_enc`
//     (services/custom-model.ts, services/agent-executor.ts).
//
// Both crossed the wire to every authenticated client — web, desktop, and the
// phone (since MOB-1: ConnectScreen lists orgs) — and sat in client JS memory.
// `apps/mobile/src/settings.ts` documented this as a known backend follow-up and
// defended itself with a render allow-list; this module fixes the actual leak at
// the source, so no client has to.
//
// THE RULE: routes never return an org row. They return `toPublicOrg(row)`.

import { schema } from '../db/client'

type OrgRow = typeof schema.organisations.$inferSelect

/**
 * The COMPLETE set of `organisations` columns a client may see. Everything here
 * is operator-authored prose, identity, or non-secret config. Adding a column to
 * this list is a deliberate act — `org-public.test.ts` fails if a new schema
 * column is classified as neither public nor secret.
 */
export const PUBLIC_ORG_FIELDS = [
  'id',
  'name',
  'description',
  'logoUrl',
  'ownerId',
  'createdAt',
  'mission',
  'culture',
  'deployMode',
  'cloudProvider',
  'preferredLlm',
  'budgetMonthlyUsd',
] as const

/**
 * Columns that carry a credential and must never reach a client.
 *
 * `deployConfig` is the one that matters: it sails past any name-based check —
 * it IS a credential without being NAMED one. (`apps/mobile/src/settings.ts`
 * learned the same lesson and keeps the same deny-list for its render path.)
 */
export const SECRET_ORG_FIELDS = ['deployConfig', 'telegramBotToken'] as const

export type PublicOrg = Pick<OrgRow, (typeof PUBLIC_ORG_FIELDS)[number]>

/**
 * Member-gated `PATCH /api/orgs/:orgId` may write ONLY these public fields.
 * Credentials, budget, deployment posture, and identity columns have dedicated
 * owner-gated routes — see GC-0b / #333 (`backend/src/routes/orgs.ts`).
 */
export const ORG_PATCH_WRITABLE_FIELDS = [
  'name',
  'description',
  'logoUrl',
  'mission',
  'culture',
] as const satisfies ReadonlyArray<(typeof PUBLIC_ORG_FIELDS)[number]>

export type OrgPatchWritableField = (typeof ORG_PATCH_WRITABLE_FIELDS)[number]

/** Tripwire: every PATCH-allowlisted field is public and never secret. */
export function orgPatchWritableFieldsAreClassified(): string[] {
  const errors: string[] = []
  for (const field of ORG_PATCH_WRITABLE_FIELDS) {
    if (!(PUBLIC_ORG_FIELDS as readonly string[]).includes(field)) {
      errors.push(`"${field}" is not in PUBLIC_ORG_FIELDS`)
    }
    if ((SECRET_ORG_FIELDS as readonly string[]).includes(field)) {
      errors.push(`"${field}" is in SECRET_ORG_FIELDS`)
    }
  }
  return errors
}

/**
 * Project an org row down to its public fields.
 *
 * Allow-list, not deny-list: a column added to the schema is invisible to
 * clients until someone puts it in `PUBLIC_ORG_FIELDS` on purpose. A new secret
 * column therefore cannot leak by default — which is exactly how this bug got
 * in, `select *` shipping whatever the table happened to grow.
 *
 * Keys are copied only when PRESENT on the input (not when merely non-null), so
 * a row's `null` columns still serialise as `null` and the response shape is
 * byte-identical to the old one minus the secrets.
 */
export function toPublicOrg<T extends Partial<OrgRow>>(org: T): PublicOrg {
  const out: Record<string, unknown> = {}
  for (const key of PUBLIC_ORG_FIELDS) {
    if (key in org) out[key] = (org as Record<string, unknown>)[key]
  }
  return out as PublicOrg
}
