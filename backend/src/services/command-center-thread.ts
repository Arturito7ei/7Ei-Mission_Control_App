// GC-2 — Command Center thread persistence (pure + DB helpers).
import { randomUUID } from 'crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'

export const MAX_TURNS = 200
export const HISTORY_LIMIT = 20
/** Mirrors connector-jira PROJECT_KEY_RE — Jira project keys are short alphanumerics. */
export const JIRA_PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/

export function parseJiraProjectKey(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  const key = String(raw).trim()
  if (!key) return null
  if (!JIRA_PROJECT_KEY_RE.test(key)) throw new Error('invalid Jira project key')
  return key
}

/** GC-3 — org-level Command Center project (stored on the Arturita default thread row). */
export async function getOrgJiraProjectKey(orgId: string): Promise<string | null> {
  const thread = await db.query.commandCenterThreads.findFirst({
    where: and(eq(schema.commandCenterThreads.orgId, orgId), eq(schema.commandCenterThreads.targetAgentKey, '')),
  })
  return thread?.jiraProjectKey ?? null
}

export async function setOrgJiraProjectKey(orgId: string, projectKey: string | null): Promise<void> {
  const thread = await getOrCreateThread(orgId, '', new Date())
  await db.update(schema.commandCenterThreads).set({ jiraProjectKey: projectKey, updatedAt: new Date() } as any)
    .where(eq(schema.commandCenterThreads.id, thread.id))
}

/** Wire / DB key for the GC-1 picker. Arturita default = '' (never NULL in UNIQUE). */
export function targetAgentKey(requestedAgentId: string | null | undefined, arturitaId: string): string {
  if (!requestedAgentId || requestedAgentId === arturitaId) return ''
  return requestedAgentId
}

export function buildUserBubbleText(message: string, attachment?: { name: string } | null, image?: { name: string } | null): string {
  const parts = [message.trim()]
  if (attachment?.name) parts.push(`📎 ${attachment.name}`)
  if (image?.name) parts.push(`🖼 ${image.name}`)
  return parts.filter(Boolean).join('\n\n')
}

export type PersistedTurnMeta = {
  mode?: string
  via?: string | null
  taskId?: string | null
  fromAgent?: string | null
  agent?: { id: string; name: string; avatarEmoji?: string | null; avatarUrl?: string | null; role?: string | null } | null
  assignedTo?: { id: string; name: string } | null
  pendingApprovalNote?: string | null
  degraded?: boolean
  routing?: unknown
}

export type PersistedTurn = {
  id: string
  role: 'user' | 'arturita' | 'assistant'
  content: string
  authorUser?: string | null
  createdAt: number
  meta?: PersistedTurnMeta
}

/** History rows for admitHistory / LLM replay. */
export function turnsToConverseHistory(turns: PersistedTurn[]): Array<{ role: 'user' | 'assistant'; content: string; fromAgent?: string }> {
  return turns
    .filter(t => t.content.trim())
    .slice(-HISTORY_LIMIT)
    .map(t => ({
      role: (t.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: t.content,
      ...(t.role !== 'user' && t.meta?.fromAgent ? { fromAgent: t.meta.fromAgent } : {}),
    }))
}

export async function getOrCreateThread(orgId: string, key: string, now = new Date()) {
  const existing = await db.query.commandCenterThreads.findFirst({
    where: and(eq(schema.commandCenterThreads.orgId, orgId), eq(schema.commandCenterThreads.targetAgentKey, key)),
  })
  if (existing) return existing
  const id = randomUUID()
  const row = { id, orgId, targetAgentKey: key, taskThreadId: null as string | null, updatedAt: now, createdAt: now }
  await db.insert(schema.commandCenterThreads).values(row as any)
  return row
}

export async function loadThread(orgId: string, key: string, limit = MAX_TURNS): Promise<{ threadId: string; taskThreadId: string | null; turns: PersistedTurn[] }> {
  const thread = await db.query.commandCenterThreads.findFirst({
    where: and(eq(schema.commandCenterThreads.orgId, orgId), eq(schema.commandCenterThreads.targetAgentKey, key)),
  })
  if (!thread) return { threadId: '', taskThreadId: null, turns: [] }
  const rows = await db.select().from(schema.commandCenterTurns)
    .where(and(eq(schema.commandCenterTurns.threadId, thread.id), eq(schema.commandCenterTurns.orgId, orgId)))
    .orderBy(desc(schema.commandCenterTurns.createdAt), desc(sql`rowid`))
    .limit(limit)
  rows.reverse()
  const turns: PersistedTurn[] = rows.map(r => ({
    id: r.id,
    role: r.role as PersistedTurn['role'],
    content: r.content,
    authorUser: r.authorUser ?? null,
    createdAt: (r.createdAt as Date).getTime(),
    meta: r.metaJson ? JSON.parse(String(r.metaJson)) as PersistedTurnMeta : undefined,
  }))
  return { threadId: thread.id, taskThreadId: thread.taskThreadId ?? null, turns }
}

export async function appendTurns(opts: {
  orgId: string
  targetAgentKey: string
  authorUser: string | null
  user: { content: string }
  assistant: { role: 'arturita' | 'assistant'; content: string; meta?: PersistedTurnMeta }
  taskThreadId?: string | null
}) {
  const now = new Date()
  const thread = await getOrCreateThread(opts.orgId, opts.targetAgentKey, now)
  const userId = randomUUID()
  const asstId = randomUUID()
  await db.insert(schema.commandCenterTurns).values([
    {
      id: userId, threadId: thread.id, orgId: opts.orgId, role: 'user',
      content: opts.user.content, authorUser: opts.authorUser, metaJson: null, createdAt: now,
    } as any,
    {
      id: asstId, threadId: thread.id, orgId: opts.orgId, role: opts.assistant.role,
      content: opts.assistant.content,
      authorUser: null,
      metaJson: opts.assistant.meta ? JSON.stringify(opts.assistant.meta) : null,
      createdAt: new Date(now.getTime() + 1),
    } as any,
  ])
  const patch: Record<string, unknown> = { updatedAt: now }
  if (opts.taskThreadId !== undefined) patch.taskThreadId = opts.taskThreadId
  await db.update(schema.commandCenterThreads).set(patch as any)
    .where(eq(schema.commandCenterThreads.id, thread.id))
  const countRows = await db.select({ id: schema.commandCenterTurns.id })
    .from(schema.commandCenterTurns)
    .where(eq(schema.commandCenterTurns.threadId, thread.id))
    .orderBy(asc(schema.commandCenterTurns.createdAt))
  if (countRows.length > MAX_TURNS) {
    const drop = countRows.slice(0, countRows.length - MAX_TURNS).map(r => r.id)
    for (const id of drop) {
      await db.delete(schema.commandCenterTurns).where(eq(schema.commandCenterTurns.id, id))
    }
  }
  return { userTurnId: userId, assistantTurnId: asstId, threadId: thread.id }
}
