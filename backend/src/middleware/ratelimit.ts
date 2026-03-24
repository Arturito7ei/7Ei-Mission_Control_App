import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and, gte } from 'drizzle-orm'

// ─── Rate Limiting with Redis fallback to in-memory ────────────────────────────────
// If REDIS_URL is set, uses Redis for distributed rate limiting across instances.
// Falls back to in-memory (single-instance) if Redis is unavailable.

interface RedisClient {
  incr: (key: string) => Promise<number>
  expire: (key: string, seconds: number) => Promise<void>
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, options?: { EX?: number }) => Promise<void>
  incrByFloat: (key: string, amount: number) => Promise<number>
  quit: () => Promise<void>
}

let redis: RedisClient | null = null

async function getRedis(): Promise<RedisClient | null> {
  if (redis) return redis
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return null
  try {
    // Dynamic import so the server starts without redis installed
    const { createClient } = await import('redis' as any)
    const client = createClient({ url: redisUrl })
    await client.connect()
    redis = client as RedisClient
    console.log('Redis connected for rate limiting')
    return redis
  } catch (err) {
    console.warn('Redis unavailable, using in-memory rate limiting:', err)
    return null
  }
}

// ─ In-memory fallback ───────────────────────────────────────────────────────
const memWindows = new Map<string, { count: number; windowStart: number }>()
const memUsage   = new Map<string, { tokens: number; cost: number; day: string }>()
const memSlots   = new Map<string, { count: number }>()

const LIMITS = {
  requestsPerMinute: Number(process.env.RATE_LIMIT_RPM         ?? 60),
  tokensPerDay:      Number(process.env.RATE_LIMIT_TOKENS_DAY  ?? 500_000),
  costPerDay:        Number(process.env.RATE_LIMIT_COST_DAY    ?? 5.0),
  concurrentTasks:   Number(process.env.RATE_LIMIT_CONCURRENT  ?? 5),
}

function today(): string { return new Date().toISOString().slice(0, 10) }

export function checkRequestRate(orgId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now(); const windowMs = 60_000
  const window = memWindows.get(orgId)
  if (!window || now - window.windowStart > windowMs) {
    memWindows.set(orgId, { count: 1, windowStart: now })
    return { allowed: true }
  }
  if (window.count >= LIMITS.requestsPerMinute) {
    return { allowed: false, retryAfter: Math.ceil((window.windowStart + windowMs - now) / 1000) }
  }
  window.count++
  return { allowed: true }
}

export function checkDailyBudget(orgId: string, estimatedTokens = 0): { allowed: boolean; remaining: { tokens: number; cost: number } } {
  let usage = memUsage.get(orgId)
  if (!usage || usage.day !== today()) { usage = { tokens: 0, cost: 0, day: today() }; memUsage.set(orgId, usage) }
  const rt = LIMITS.tokensPerDay - usage.tokens
  const rc = LIMITS.costPerDay - usage.cost
  if (usage.tokens + estimatedTokens > LIMITS.tokensPerDay || usage.cost >= LIMITS.costPerDay) {
    return { allowed: false, remaining: { tokens: Math.max(0, rt), cost: Math.max(0, rc) } }
  }
  return { allowed: true, remaining: { tokens: rt, cost: rc } }
}

export function recordUsage(orgId: string, tokens: number, costUsd: number): void {
  let usage = memUsage.get(orgId)
  if (!usage || usage.day !== today()) { usage = { tokens: 0, cost: 0, day: today() } }
  usage.tokens += tokens; usage.cost += costUsd
  memUsage.set(orgId, usage)

  // Async Redis sync (non-blocking)
  getRedis().then(r => {
    if (!r) return
    const key = `usage:${orgId}:${today()}`
    r.incrByFloat(`${key}:tokens`, tokens).catch(() => {})
    r.incrByFloat(`${key}:cost`, costUsd).catch(() => {})
    r.expire(`${key}:tokens`, 90000).catch(() => {}) // 25h TTL
    r.expire(`${key}:cost`, 90000).catch(() => {})
  }).catch(() => {})
}

export function acquireTaskSlot(orgId: string): boolean {
  const current = memSlots.get(orgId) ?? { count: 0 }
  if (current.count >= LIMITS.concurrentTasks) return false
  current.count++; memSlots.set(orgId, current)
  return true
}

export function releaseTaskSlot(orgId: string): void {
  const current = memSlots.get(orgId)
  if (current && current.count > 0) { current.count--; memSlots.set(orgId, current) }
}

export function getUsageStats(orgId: string) {
  const window = memWindows.get(orgId)
  const usage  = memUsage.get(orgId)
  const slots  = memSlots.get(orgId)
  return {
    requestsThisMinute: window?.count ?? 0,
    tokensToday:  usage?.day === today() ? usage.tokens : 0,
    costToday:    usage?.day === today() ? usage.cost : 0,
    concurrentTasks: slots?.count ?? 0,
    limits: LIMITS,
    backend: redis ? 'redis' : 'memory',
  }
}

export async function checkMonthlyBudget(orgId: string): Promise<{ allowed: boolean; percentUsed: number; remaining: number }> {
  const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
  const budgetLimit = org?.budgetMonthlyUsd ?? null
  if (budgetLimit == null) return { allowed: true, percentUsed: 0, remaining: Infinity }

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const tasks = await db.select({ costUsd: schema.tasks.costUsd })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.orgId, orgId), gte(schema.tasks.createdAt, startOfMonth)))

  const usedThisMonth = tasks.reduce((s, t) => s + (t.costUsd ?? 0), 0)
  const percentUsed = Math.round((usedThisMonth / budgetLimit) * 100)
  const remaining = Math.max(0, budgetLimit - usedThisMonth)
  return { allowed: percentUsed < 100, percentUsed, remaining }
}

export async function usageRoutes(app: FastifyInstance) {
  // Init Redis on startup
  getRedis().catch(() => {})

  app.get('/api/orgs/:orgId/usage', async (req) => {
    return { usage: getUsageStats((req.params as any).orgId) }
  })
  app.get('/api/orgs/:orgId/limits', async () => ({ limits: LIMITS }))
}
