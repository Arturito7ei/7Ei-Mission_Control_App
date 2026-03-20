import { FastifyInstance } from 'fastify'

interface RateWindow { count: number; windowStart: number }
interface DailyUsage { tokens: number; cost: number; day: string }
interface ConcurrentSlots { count: number }

const requestWindows = new Map<string, RateWindow>()
const dailyUsage = new Map<string, DailyUsage>()
const concurrentSlots = new Map<string, ConcurrentSlots>()

const LIMITS = {
  requestsPerMinute: Number(process.env.RATE_LIMIT_RPM ?? 60),
  tokensPerDay: Number(process.env.RATE_LIMIT_TOKENS_DAY ?? 500_000),
  costPerDay: Number(process.env.RATE_LIMIT_COST_DAY ?? 5.0),
  concurrentTasks: Number(process.env.RATE_LIMIT_CONCURRENT ?? 5),
}

export function checkRequestRate(orgId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const windowMs = 60_000
  const window = requestWindows.get(orgId)
  if (!window || now - window.windowStart > windowMs) {
    requestWindows.set(orgId, { count: 1, windowStart: now })
    return { allowed: true }
  }
  if (window.count >= LIMITS.requestsPerMinute) {
    return { allowed: false, retryAfter: Math.ceil((window.windowStart + windowMs - now) / 1000) }
  }
  window.count++
  return { allowed: true }
}

export function checkDailyBudget(orgId: string, estimatedTokens = 0): { allowed: boolean; remaining: { tokens: number; cost: number } } {
  const today = new Date().toISOString().slice(0, 10)
  let usage = dailyUsage.get(orgId)
  if (!usage || usage.day !== today) { usage = { tokens: 0, cost: 0, day: today }; dailyUsage.set(orgId, usage) }
  const remainingTokens = LIMITS.tokensPerDay - usage.tokens
  const remainingCost = LIMITS.costPerDay - usage.cost
  if (usage.tokens + estimatedTokens > LIMITS.tokensPerDay || usage.cost >= LIMITS.costPerDay) {
    return { allowed: false, remaining: { tokens: Math.max(0, remainingTokens), cost: Math.max(0, remainingCost) } }
  }
  return { allowed: true, remaining: { tokens: remainingTokens, cost: remainingCost } }
}

export function recordUsage(orgId: string, tokens: number, costUsd: number): void {
  const today = new Date().toISOString().slice(0, 10)
  let usage = dailyUsage.get(orgId)
  if (!usage || usage.day !== today) { usage = { tokens: 0, cost: 0, day: today } }
  usage.tokens += tokens
  usage.cost += costUsd
  dailyUsage.set(orgId, usage)
}

export function acquireTaskSlot(orgId: string): boolean {
  const current = concurrentSlots.get(orgId) ?? { count: 0 }
  if (current.count >= LIMITS.concurrentTasks) return false
  current.count++
  concurrentSlots.set(orgId, current)
  return true
}

export function releaseTaskSlot(orgId: string): void {
  const current = concurrentSlots.get(orgId)
  if (current && current.count > 0) { current.count--; concurrentSlots.set(orgId, current) }
}

export function getUsageStats(orgId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const window = requestWindows.get(orgId)
  const usage = dailyUsage.get(orgId)
  const concurrent = concurrentSlots.get(orgId)
  return {
    requestsThisMinute: window?.count ?? 0,
    tokensToday: usage?.day === today ? usage.tokens : 0,
    costToday: usage?.day === today ? usage.cost : 0,
    concurrentTasks: concurrent?.count ?? 0,
    limits: LIMITS,
  }
}

export async function usageRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/usage', async (req) => {
    const { orgId } = req.params as any
    return { usage: getUsageStats(orgId) }
  })
  app.get('/api/orgs/:orgId/limits', async () => ({ limits: LIMITS }))
}
