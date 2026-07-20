// AAD-1 — credential revocation for agent delete.
//
// Deleting an agent must not leave live credentials dangling. libSQL foreign keys are
// OFF per connection and `schema.ts` declares no `references(...)`, so nothing cascades:
// every credential an agent holds has to be revoked in explicit application code. The
// dangerous one is `agent_oauth_tokens` — an ownerless Google REFRESH token that never
// expires and stays valid at Google until revoked upstream.
//
// This helper is the single place that enumerates what a live agent holds. It is
// deliberately a pure service (no route/req coupling) so the delete route and its tests
// share one revocation path — the same reason `allSecretFieldKeys()` is the one source
// of truth for audit redaction.

import { db, schema } from '../db/client'
import { and, eq, isNull } from 'drizzle-orm'
import { deleteAgentGoogleToken } from './agent-google-auth'

/**
 * The reusable "not soft-deleted" condition. EVERY enumeration/render read path over
 * `agents` (roster, staff grid, org chart, advisor & manager pickers) `and`s this in, so
 * a soft-deleted agent cannot re-appear in a list through a query that forgot the filter.
 * Historical single-row joins (rendering a deleted agent's name on a past task) do NOT
 * use it — the row is retained on purpose.
 */
export const agentNotDeleted = isNull(schema.agents.deletedAt)

export interface AgentCredentialCleanup {
  /** OAuth providers whose tokens were revoked upstream (best-effort) and purged. */
  oauthProvidersRevoked: string[]
  /** Pending single-use OAuth state rows dropped. */
  oauthStatesDeleted: number
  /** Agent-scoped `secrets` rows (connector credentials) deleted. */
  secretsDeleted: number
  /** `agent_connectors` rows marked disabled. */
  connectorsDisabled: number
}

const rowsAffected = (res: any): number =>
  Number(res?.rowsAffected ?? res?.changes ?? res?.rows_affected ?? 0)

/**
 * Revoke and purge every live credential the agent holds. Local purges are AWAITED so a
 * caller can assert them; upstream Google revocation is best-effort inside
 * `deleteAgentGoogleToken` (a network failure there still deletes the local token row).
 *
 * The agent's own bearer token is NOT handled here — the delete route nulls
 * `agents.apiTokenHash` as part of the soft-delete row write, and the token resolver
 * also filters `deletedAt IS NULL` (middleware/agent-token.ts).
 */
export async function revokeAgentCredentials(orgId: string, agentId: string): Promise<AgentCredentialCleanup> {
  // 1) Google (and any future provider) OAuth tokens — the refresh-token blast radius.
  //    Revoke upstream + delete the encrypted row, per provider present.
  const oauthRows = await db.select({ provider: schema.agentOauthTokens.provider })
    .from(schema.agentOauthTokens)
    .where(and(eq(schema.agentOauthTokens.orgId, orgId), eq(schema.agentOauthTokens.agentId, agentId)))
  const oauthProvidersRevoked = [...new Set(oauthRows.map(r => r.provider))]
  for (const provider of oauthProvidersRevoked) {
    await deleteAgentGoogleToken(orgId, agentId, provider)
  }
  // Pending single-use CSRF/PKCE state rows — orphaned otherwise (they expire in 10min,
  // but leave nothing behind).
  const statesRes = await db.delete(schema.agentOauthStates)
    .where(and(eq(schema.agentOauthStates.orgId, orgId), eq(schema.agentOauthStates.agentId, agentId)))

  // 2) Agent-scoped secrets (connector credentials). NOTE the column is `scopeId`, not
  //    `agentId` — a naive `agentId` sweep MISSES these, which is exactly how they were
  //    orphaned by the legacy hard delete.
  const secretsRes = await db.delete(schema.secrets)
    .where(and(
      eq(schema.secrets.orgId, orgId),
      eq(schema.secrets.scope, 'agent'),
      eq(schema.secrets.scopeId, agentId),
    ))

  // 3) Connectors — disable (retain the row for audit; its credential is now gone).
  const connRes = await db.update(schema.agentConnectors)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId)))

  return {
    oauthProvidersRevoked,
    oauthStatesDeleted: rowsAffected(statesRes),
    secretsDeleted: rowsAffected(secretsRes),
    connectorsDisabled: rowsAffected(connRes),
  }
}
