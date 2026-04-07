// ─── Telegram Bot Commands ──────────────────────────────────────────────────────
// Handlers for /start, /status, /agents, /tasks, /ask, /help

import { db, schema } from '../db/client'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { TelegramBot, escapeMarkdownV2, inlineKeyboardRows } from '../services/telegram-bot'

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

// /start — Register and link to org
export async function handleStart(ctx: CommandContext): Promise<void> {
  // Check if already linked
  const existing = await resolveOrgFromChat(ctx.chatId)
  if (existing) {
    await ctx.bot.sendMessage(ctx.chatId,
      `👋 Welcome back\\! You're connected to *${escapeMarkdownV2(existing.orgName)}*\\.\n\nType /help to see available commands\\.`,
      { parseMode: 'MarkdownV2' })
    return
  }

  // Find orgs for this user or create a link
  const orgs = await db.select().from(schema.organisations).limit(1)
  if (orgs.length > 0) {
    const org = orgs[0]
    // Link this chat to the org
    await db.insert(schema.orgMembers).values({
      id: randomUUID(),
      orgId: org.id,
      userId: `telegram_${ctx.chatId}`,
      role: 'member',
      telegramChatId: String(ctx.chatId),
      createdAt: new Date(),
    })
    await ctx.bot.sendMessage(ctx.chatId,
      `🎯 *Welcome to 7Ei Mission Control\\!*\n\nYou're now connected to *${escapeMarkdownV2(org.name)}*\\.\n\n` +
      `I'm Arturito, your Chief of Staff\\. You can:\n` +
      `• Just type a message to chat with me\n` +
      `• Use /agents to see your team\n` +
      `• Use /tasks to check open work\n` +
      `• Use /help for all commands`,
      { parseMode: 'MarkdownV2' })
  } else {
    await ctx.bot.sendMessage(ctx.chatId,
      '🤖 Welcome to 7Ei Mission Control\\!\n\nNo organisations found yet\\. Create one in the app first, then come back here\\.',
      { parseMode: 'MarkdownV2' })
  }
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
    `/start — Connect to your organisation\n` +
    `/status — Org health summary\n` +
    `/agents — List agents \\(tap to chat\\)\n` +
    `/tasks — View recent tasks\n` +
    `/ask \\<question\\> — Ask Arturito directly\n` +
    `/help — Show this message\n\n` +
    `Or just type any message to chat with Arturito\\!`,
    { parseMode: 'MarkdownV2' })
}

// Route command to handler
export function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/)
  if (!match) return null
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}
