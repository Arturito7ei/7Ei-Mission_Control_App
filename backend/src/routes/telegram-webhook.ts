// ─── Telegram Webhook Route ──────────────────────────────────────────────────────
// POST /api/telegram/webhook — receives Telegram updates
// POST /api/telegram/setup-webhook — configures the webhook URL

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { TelegramBot, formatAgentResponse } from '../services/telegram-bot'
import { executeAgentTask } from '../services/agent-executor'
import {
  parseCommand, handleStart, handleStatus, handleAgents,
  handleTasks, handleHelp, resolveOrgFromChat,
  type CommandContext,
} from './telegram-commands'

export async function telegramWebhookRoutes(app: FastifyInstance) {
  // POST /api/telegram/webhook — receive Telegram updates
  app.post('/api/telegram/webhook', async (req, reply) => {
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
    if (webhookSecret) {
      const headerSecret = req.headers['x-telegram-bot-api-secret-token']
      if (headerSecret !== webhookSecret) {
        return reply.code(403).send({ error: 'Invalid webhook secret' })
      }
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return reply.code(200).send({ ok: true }) // silently ignore without token

    const bot = new TelegramBot(botToken)
    const update = req.body as any

    try {
      // Handle callback queries (inline keyboard taps)
      if (update.callback_query) {
        await handleCallbackQuery(bot, update.callback_query)
        return reply.code(200).send({ ok: true })
      }

      // Handle messages
      const message = update.message
      if (!message?.text) return reply.code(200).send({ ok: true })

      const chatId = message.chat.id
      const text = message.text.trim()

      // Resolve org context
      const orgCtx = await resolveOrgFromChat(chatId)
      const ctx: CommandContext = {
        bot, chatId, text,
        userId: orgCtx?.userId ?? `telegram_${chatId}`,
        orgId: orgCtx?.orgId,
        orgName: orgCtx?.orgName,
      }

      // Parse and route commands
      const cmd = parseCommand(text)
      if (cmd) {
        switch (cmd.command) {
          case 'start': await handleStart(ctx); break
          case 'status': await handleStatus(ctx); break
          case 'agents': await handleAgents(ctx); break
          case 'tasks': await handleTasks(ctx); break
          case 'help': await handleHelp(ctx); break
          case 'ask':
            if (cmd.args) await routeToAgent(bot, chatId, cmd.args, orgCtx)
            else await bot.sendMessage(chatId, 'Usage: /ask <your question>')
            break
          default:
            await bot.sendMessage(chatId, `Unknown command: /${cmd.command}. Try /help`)
        }
        return reply.code(200).send({ ok: true })
      }

      // Plain text → route to Arturito
      await routeToAgent(bot, chatId, text, orgCtx)
    } catch (err) {
      console.error('Telegram webhook error:', err)
    }

    return reply.code(200).send({ ok: true })
  })

  // POST /api/telegram/setup-webhook — configure webhook URL
  app.post('/api/telegram/setup-webhook', async (req, reply) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return reply.code(400).send({ error: 'TELEGRAM_BOT_TOKEN not set' })

    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? randomUUID()
    const baseUrl = process.env.PUBLIC_URL ?? 'https://7ei-backend.fly.dev'
    const webhookUrl = `${baseUrl}/api/telegram/webhook`

    const bot = new TelegramBot(botToken)
    const result = await bot.setWebhook(webhookUrl, webhookSecret)

    return {
      ok: result.ok,
      webhookUrl,
      description: result.description,
      hint: webhookSecret !== process.env.TELEGRAM_WEBHOOK_SECRET
        ? `Set TELEGRAM_WEBHOOK_SECRET=${webhookSecret} as an env var`
        : undefined,
    }
  })

  // GET /api/telegram/webhook-info
  app.get('/api/telegram/webhook-info', async () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return { error: 'TELEGRAM_BOT_TOKEN not set' }
    const bot = new TelegramBot(botToken)
    return bot.getWebhookInfo()
  })
}

// Route a message to the org's Arturito agent
async function routeToAgent(
  bot: TelegramBot,
  chatId: number,
  text: string,
  orgCtx: { orgId: string; userId: string } | null,
  agentId?: string,
) {
  if (!orgCtx) {
    await bot.sendMessage(chatId, 'Not linked to an org yet. Use /start first.')
    return
  }

  // Show typing indicator
  await bot.sendChatAction(chatId, 'typing')

  // Find agent — default to Arturito (first agent with 'orchestrator' or 'chief of staff' in role)
  let agent: any
  if (agentId) {
    agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  } else {
    const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, orgCtx.orgId))
    agent = agents.find(a =>
      a.role.toLowerCase().includes('orchestrator') ||
      a.role.toLowerCase().includes('chief of staff') ||
      a.name === 'Arturito'
    ) ?? agents[0]
  }

  if (!agent) {
    await bot.sendMessage(chatId, 'No agents found in your org. Create one in the app first.')
    return
  }

  // Create task and execute
  const taskId = randomUUID()
  await db.insert(schema.tasks).values({
    id: taskId,
    agentId: agent.id,
    orgId: orgCtx.orgId,
    title: `[Telegram] ${text.slice(0, 80)}`,
    input: text,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date(),
  })

  try {
    const result = await executeAgentTask({
      agentId: agent.id,
      taskId,
      input: text,
    })

    // Send response (split if too long — Telegram has 4096 char limit)
    const response = result.output
    if (response.length <= 4000) {
      await bot.sendMessage(chatId, `${agent.avatarEmoji} *${agent.name}*\n\n${response}`)
    } else {
      // Split into chunks
      for (let i = 0; i < response.length; i += 4000) {
        const chunk = response.slice(i, i + 4000)
        const prefix = i === 0 ? `${agent.avatarEmoji} *${agent.name}*\n\n` : ''
        await bot.sendMessage(chatId, prefix + chunk)
      }
    }
  } catch (err: any) {
    await bot.sendMessage(chatId, `❌ Error: ${err.message?.slice(0, 200) ?? 'Agent execution failed'}`)
  }
}

// Handle inline keyboard callbacks
async function handleCallbackQuery(bot: TelegramBot, query: any) {
  const chatId = query.message?.chat?.id
  const data = query.data as string
  if (!chatId || !data) return

  await bot.answerCallbackQuery(query.id)

  // chat_<agentId> — start chat with specific agent
  if (data.startsWith('chat_')) {
    const agentId = data.slice(5)
    const orgCtx = await resolveOrgFromChat(chatId)
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (agent && orgCtx) {
      await bot.sendMessage(chatId, `Now chatting with ${agent.avatarEmoji} *${agent.name}*. Send your message:`)
      // Note: subsequent messages will still route to Arturito by default.
      // Full agent switching would need chat state management.
    }
  }
}
