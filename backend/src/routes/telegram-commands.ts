// ─── Telegram Bot Commands ──────────────────────────────────────────────────────
// Handlers for /start, /status, /agents, /tasks, /ask, /help

import { db, schema } from '../db/client'
import { eq, desc } from 'drizzle-orm'
import { TelegramBot, escapeMarkdownV2, inlineKeyboardRows } from '../services/telegram-bot'
import { linkTelegramChatFromBindCode } from '../services/telegram-bind'
import {
  normalizeBindCode,
  unlinkedStartMessage,
  bindCodeAcceptedMessage,
  bindCodeRejectedMessage,
} from '../services/telegram-start'

export interface CommandContext {
  bot: TelegramBot
  chatId: number
  userId: string
  text: string
  orgId?: string
  orgName?: string
}

// Resolve org from telegram chat ID
export async function resolveOrgFromChat(chatId: number): Promise<{ orgId: string; orgName: string; userId: string } | null> {
  const member = await db.query.orgMembers.findFirst({
    where: eq(schema.orgMembers.telegramChatId, String(chatId)),
  })
  if (!member) return null
  const org = await db.query.organisations.findFirst({
    where: eq(schema.organisations.id, member.orgId),
  })
  if (!org) return null
  return { orgId: org.id, orgName: org.name, userId: member.userId }
}

// /start — Link via Cockpit one-time bind code only (CRIT-01: never auto-link first org)
export async function handleStart(ctx: CommandContext, bindCodeArgs = ''): Promise<void> {
  const existing = await resolveOrgFromChat(ctx.chatId)
  if (existing) {
    await ctx.bot.sendMessage(ctx.chatId,
      `👋 Welcome back\\! You're connected to *${escapeMarkdownV2(existing.orgName)}*\\.\n\nType /help to see available commands\\.`,
      { parseMode: 'MarkdownV2' })
    return
  }

  const code = normalizeBindCode(bindCodeArgs)
  if (!code) {
    await ctx.bot.sendMessage(ctx.chatId, unlinkedStartMessage(), { parseMode: 'MarkdownV2' })
    return
  }

  const linked = await linkTelegramChatFromBindCode(ctx.chatId, code)
  if (!linked.ok || !linked.orgName) {
    await ctx.bot.sendMessage(ctx.chatId, bindCodeRejectedMessage(linked.error ?? 'bind failed'), { parseMode: 'MarkdownV2' })
    return
  }

  await ctx.bot.sendMessage(ctx.chatId, bindCodeAcceptedMessage(linked.orgName), { parseMode: 'MarkdownV2' })
}

// /status — Org health summary
export async function handleStatus(ctx: CommandContext): Promise<void> {
  if (!ctx.orgId) { await ctx.bot.sendMessage(ctx.chatId, 'Not linked to an org. Use /start first.'); return }

  const [agents, tasks, org] = await Promise.all([
    db.select().from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId!)),
    db.select().from(schema.tasks).where(eq(schema.tasks.orgId, ctx.orgId!)),
    db.query.organisations.findFirst({ where: eq(schema.organisations.id, ctx.orgId!) }),
  ])

  const active = agents.filter(a => a.status === 'active').length
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length
  const done = tasks.filter(t => t.status === 'done').length
  const totalCost = tasks.reduce((s, t) => s + (t.costUsd ?? 0), 0)

  await ctx.bot.sendMessage(ctx.chatId,
    `📊 *${escapeMarkdownV2(org?.name ?? 'Org')} Status*\n\n` +
    `🤖 Agents: ${agents.length} \\(${active} active\\)\n` +
    `📋 Tasks: ${pending} pending, ${done} done\n` +
    `💰 Total cost: \\$${escapeMarkdownV2(totalCost.toFixed(4))}`,
    { parseMode: 'MarkdownV2' })
}

// /agents — List agents with chat buttons
export async function handleAgents(ctx: CommandContext): Promise<void> {
  if (!ctx.orgId) { await ctx.bot.sendMessage(ctx.chatId, 'Not linked to an org. Use /start first.'); return }

  const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId!))
  if (agents.length === 0) {
    await ctx.bot.sendMessage(ctx.chatId, 'No agents yet. Create them in the app first.')
    return
  }

  const buttons = agents.slice(0, 8).map(a => ({
    text: `${a.avatarEmoji} ${a.name}`,
    callbackData: `chat_${a.id}`,
  }))

  await ctx.bot.sendMessage(ctx.chatId,
    `🤖 *Your Agents*\n\n` +
    agents.map(a => `${a.avatarEmoji} *${escapeMarkdownV2(a.name)}* — ${escapeMarkdownV2(a.role)} \\(${a.status}\\)`).join('\n'),
    { parseMode: 'MarkdownV2', replyMarkup: inlineKeyboardRows(buttons) })
}

// /tasks — List open tasks
export async function handleTasks(ctx: CommandContext): Promise<void> {
  if (!ctx.orgId) { await ctx.bot.sendMessage(ctx.chatId, 'Not linked to an org. Use /start first.'); return }

  const tasks = await db.select().from(schema.tasks)
    .where(eq(schema.tasks.orgId, ctx.orgId!))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(10)

  if (tasks.length === 0) {
    await ctx.bot.sendMessage(ctx.chatId, 'No tasks yet.')
    return
  }

  const statusEmoji: Record<string, string> = { pending: '⏳', in_progress: '🔄', done: '✅', failed: '❌', blocked: '🚫' }
  const lines = tasks.map(t =>
    `${statusEmoji[t.status] ?? '📋'} ${escapeMarkdownV2(t.title.slice(0, 50))} \\(${t.status}\\)`
  )

  await ctx.bot.sendMessage(ctx.chatId,
    `📋 *Recent Tasks*\n\n${lines.join('\n')}`,
    { parseMode: 'MarkdownV2' })
}

// /help — Available commands
export async function handleHelp(ctx: CommandContext): Promise<void> {
  await ctx.bot.sendMessage(ctx.chatId,
    `🎯 *7Ei Mission Control Bot*\n\n` +
    `Available commands:\n` +
    `/start \\<bind\\-code\\> — Link Telegram to your organisation\n` +
    `/status — Org health summary\n` +
    `/agents — List agents \\(tap to chat\\)\n` +
    `/tasks — View recent tasks\n` +
    `/ask \\<question\\> — Ask Arturita directly\n` +
    `/help — Show this message\n\n` +
    `Or just type any message to chat with Arturita\\!`,
    { parseMode: 'MarkdownV2' })
}

// Route command to handler
export function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/)
  if (!match) return null
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}
