// Agent memory bus (MCA-75) — per-agent vault memory under Memory/agents/<slug>/.
// Pure formatting/path helpers + one fetch wrapper that pulls the org + agent
// long-term notes from the shared vault into a system-prompt block. Paths follow
// the same convention as PUT /api/agent/memory/file: root-prefixed, so they pass
// isSafeVaultPath(path, cfg.root) (e.g. `vault/Memory/agents/arturito/recent.md`).

import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { decrypt } from './secrets'
import { VaultConfig, parseVaultConfig, vaultRead } from './vault-connector'

/** Kebab-case an agent name for vault paths: "Arturito R2D2" → "arturito-r2d2". */
export function slugifyAgentName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Root-relative memory directory for an agent: `Memory/agents/<slug>`. */
export function agentMemoryDir(name: string): string {
  return `Memory/agents/${slugifyAgentName(name)}`
}

const withRoot = (root: string, rel: string): string => {
  const r = String(root ?? '').replace(/^\/+|\/+$/g, '')
  return r ? `${r}/${rel}` : rel
}

/** Session-continuity log: `<root>/Memory/agents/<slug>/recent.md`. */
export function agentRecentPath(name: string, root: string): string {
  return withRoot(root, `${agentMemoryDir(name)}/recent.md`)
}

/** Curated agent notes: `<root>/Memory/agents/<slug>/long-term.md`. */
export function agentLongTermPath(name: string, root: string): string {
  return withRoot(root, `${agentMemoryDir(name)}/long-term.md`)
}

/** Nightly DB-memory mirror: `<root>/Memory/agents/<slug>/kv.md`. */
export function agentKvPath(name: string, root: string): string {
  return withRoot(root, `${agentMemoryDir(name)}/kv.md`)
}

/** Session blocks pruned from recent.md (MCA-76): `<root>/Memory/agents/<slug>/archive-recent.md`. */
export function agentArchiveRecentPath(name: string, root: string): string {
  return withRoot(root, `${agentMemoryDir(name)}/archive-recent.md`)
}

/** Accumulated lessons log: `<root>/Memory/agents/<slug>/lessons.md`. */
export function agentLessonsPath(name: string, root: string): string {
  return withRoot(root, `${agentMemoryDir(name)}/lessons.md`)
}

/** Org-wide shared notes: `<root>/Memory/long-term.md`. */
export function orgLongTermPath(root: string): string {
  return withRoot(root, 'Memory/long-term.md')
}

/** Session-continuity block appended to recent.md — empty optional lines are omitted. */
export function formatSessionSummary(input: {
  date: string; focus: string; completed?: string; blockers?: string; next?: string; agentName: string
}): string {
  const lines = [`## Session: ${input.date} — ${input.agentName}`, `- **Focus:** ${input.focus}`]
  if (input.completed) lines.push(`- **Completed:** ${input.completed}`)
  if (input.blockers)  lines.push(`- **Blockers:** ${input.blockers}`)
  if (input.next)      lines.push(`- **Next:** ${input.next}`)
  return lines.join('\n')
}

/** Append a block with exactly one blank line separator; missing/empty file → block as-is. */
export function appendSection(existing: string | undefined, block: string): string {
  const prev = String(existing ?? '').replace(/\s+$/, '')
  return prev ? `${prev}\n\n${block}` : block
}

/** Deterministic markdown mirror of an agent's DB memory (sorted by key, no frontmatter). */
export function formatKvExport(
  agentName: string,
  kvs: Array<{ key: string; value: string; updatedAt?: Date | null }>,
  generatedAt: Date = new Date(),
): string {
  const sorted = [...kvs].sort((a, b) => a.key.localeCompare(b.key))
  const lines = [`# Memory KV export — ${agentName}`, '']
  for (const kv of sorted) {
    const updated = kv.updatedAt ? ` _(updated ${kv.updatedAt.toISOString().slice(0, 10)})_` : ''
    lines.push(`- **${kv.key}:** ${kv.value}${updated}`)
  }
  lines.push('', `_Generated: ${generatedAt.toISOString()}_`)
  return lines.join('\n')
}

/** Build the SHARED MEMORY system-prompt block; '' when both inputs are empty. */
export function sharedMemoryBlock(orgLongTerm: string | null, agentLongTerm: string | null, maxChars = 4000): string {
  const truncate = (s: string) => s.length > maxChars ? s.slice(0, maxChars) + '\n[truncated]' : s
  const org = String(orgLongTerm ?? '').trim()
  const agent = String(agentLongTerm ?? '').trim()
  if (!org && !agent) return ''
  const parts: string[] = []
  if (org)   parts.push('=== SHARED MEMORY (org long-term) ===', truncate(org))
  if (agent) parts.push('=== AGENT LONG-TERM MEMORY ===', truncate(agent))
  parts.push('=== END SHARED MEMORY ===')
  return parts.join('\n')
}

// ─ Shared-memory TTL cache — one vault round-trip per agent per 5 minutes ────
const SHARED_MEMORY_TTL_MS = 5 * 60_000
const sharedMemoryCache = new Map<string, { block: string; fetchedAt: number }>()

export function sharedMemoryCacheKey(cfg: VaultConfig, agentName: string): string {
  return `${cfg.repo}:${agentName}`
}

export function getCachedSharedMemory(key: string, now: number = Date.now()): string | null {
  const hit = sharedMemoryCache.get(key)
  if (!hit) return null
  if (now - hit.fetchedAt > SHARED_MEMORY_TTL_MS) { sharedMemoryCache.delete(key); return null }
  return hit.block
}

export function setCachedSharedMemory(key: string, block: string, fetchedAt: number = Date.now()): void {
  sharedMemoryCache.set(key, { block, fetchedAt })
}

export function clearSharedMemoryCache(): void {
  sharedMemoryCache.clear()
}

/** Read org + agent long-term notes from the vault and build the prompt block.
 *  404s (file not created yet) are tolerated as null; results are TTL-cached. */
export async function fetchSharedMemory(token: string, cfg: VaultConfig, agentName: string): Promise<{ block: string }> {
  const key = sharedMemoryCacheKey(cfg, agentName)
  const cached = getCachedSharedMemory(key)
  if (cached !== null) return { block: cached }
  const readOrNull = async (path: string): Promise<string | null> => {
    const r = await vaultRead(token, cfg, path)
    return r.ok ? (r.markdown ?? '') : null
  }
  const [org, agent] = await Promise.all([
    readOrNull(orgLongTermPath(cfg.root)),
    readOrNull(agentLongTermPath(agentName, cfg.root)),
  ])
  const block = sharedMemoryBlock(org, agent)
  setCachedSharedMemory(key, block)
  return { block }
}

/** Resolve an org's vault token + config (mirrors resolveVault in agent-api.ts,
 *  which is route-local — services must not import from routes). */
export async function resolveVaultForOrg(orgId: string): Promise<{ token: string | null; cfg: VaultConfig }> {
  const rows = await db.select().from(schema.secrets).where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company')))
  const get = (k: string): string | null => { const r = rows.find(x => x.key === k); if (!r) return null; try { return decrypt(r.valueEncrypted) } catch { return null } }
  return { token: process.env.VAULT_GH_TOKEN || get('GITHUB_VAULT_TOKEN'), cfg: parseVaultConfig(get('VAULT_CONFIG')) }
}
