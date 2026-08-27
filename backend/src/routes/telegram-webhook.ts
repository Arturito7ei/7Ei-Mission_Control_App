// ─── Telegram Webhook Routes ──────────────────────────────────────────────────────
// POST /api/telegram/webhook — receives Telegram updates (public; HMAC header)
// POST /api/telegram/setup-webhook — configure webhook URL (Clerk-secured scope)
// GET /api/telegram/webhook-info — probe Telegram webhook state (Clerk-secured scope)

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { TelegramBot } from '../services/telegram-bot'
import { webhookFailClosed, resolveTelegramWebhookSecret } from '../services/webhook-auth'
import { runArturitaConverseTurn, NO_LLM_MESSAGE } from '../services/arturita-converse-turn'
import {
  parseCommand, handleStart, handleStatus, handleAgents,
  handleTasks, handleHelp, resolveOrgFromChat,
  type CommandContext,
} from './telegram-commands'

const FLY_SECRETS_HINT =
  'Operator action: set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET on Fly (7ei-backend), then redeploy.'

/** Inbound receiver — Telegram POSTs here with no Clerk session. */
export async function telegramWebhookReceiverRoutes(app: FastifyInstance) {
  app.post('/api/telegram/webhook', async (req, reply) => {
    const webhookSecret = resolveTelegramWebhookSecret()
    if (!webhookSecret && webhookFailClosed(process.env.NODE_ENV)) {
      return reply.code(403).send({ error: 'Webhook signing secret not configured' })
    }
    if (webhookSecret) {
      const headerSecret = req.headers['x-telegram-bot-api-secret-token']
      if (headerSecret !== webhookSecret) {
        return reply.code(403).send({ error: 'Invalid webhook secret' })
      }
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return reply.code(200).send({ ok: true })

    const bot = new TelegramBot(botToken)
    const update = req.body as any

    try {
      if (update.callback_query) {
        await handleCallbackQuery(bot, update.callback_query)
        return reply.code(200).send({ ok: true })
      }

      const message = update.message
      if (!message?.text) return reply.code(200).send({ ok: true })

      const chatId = message.chat.id
      const text = message.text.trim()

      const orgCtx = await resolveOrgFromChat(chatId)
      const ctx: CommandContext = {
        bot, chatId, text,
        userId: orgCtx?.userId ?? `telegram_${chatId}`,
        orgId: orgCtx?.orgId,
        orgName: orgCtx?.orgName,
      }

      const cmd = parseCommand(text)
      if (cmd) {
        switch (cmd.command) {
          case 'start': await handleStart(ctx, cmd.args); break
          case 'status': await handleStatus(ctx); break
          case 'agents': await handleAgents(ctx); break
          case 'tasks': await handleTasks(ctx); break
          case 'help': await handleHelp(ctx); break
          case 'ask':
            if (cmd.args) await routeToArturita(bot, chatId, cmd.args, orgCtx)
            else await bot.sendMessage(chatId, 'Usage: /ask <your question>')
            break
          default:
            await bot.sendMessage(chatId, `Unknown command: /${cmd.command}. Try /help`)
        }
        return reply.code(200).send({ ok: true })
      }

      await routeToArturita(bot, chatId, text, orgCtx)
    } catch (err) {
      console.error('Telegram webhook error:', err)
    }

    return reply.code(200).send({ ok: true })
  })
}

/** Deploy-time registration probes — register inside the Clerk-secured scope (index.ts). */
export async function telegramWebhookAdminRoutes(app: FastifyInstance) {
  app.post('/api/telegram/setup-webhook', async (req, reply) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) {
      return reply.code(400).send({
        error: 'TELEGRAM_BOT_TOKEN is not set on the backend.',
        hint: FLY_SECRETS_HINT,
      })
    }

    const webhookSecret = resolveTelegramWebhookSecret()
    if (!webhookSecret) {
      return reply.code(400).send({
        error: 'TELEGRAM_WEBHOOK_SECRET must be set before registering the webhook.',
        hint: FLY_SECRETS_HINT,
      })
    }

    const baseUrl = process.env.PUBLIC_URL ?? 'https://7ei-backend.fly.dev'
    const webhookUrl = `${baseUrl}/api/telegram/webhook`

    const bot = new TelegramBot(botToken)
    const result = await bot.setWebhook(webhookUrl, webhookSecret)

    return {
      ok: result.ok,
      webhookUrl,
      description: result.description,
    }
  })

  app.get('/api/telegram/webhook-info', async () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return { error: 'TELEGRAM_BOT_TOKEN is not set on the backend.', hint: FLY_SECRETS_HINT }
    const bot = new TelegramBot(botToken)
    return bot.getWebhookInfo()
  })
}

/** @deprecated Register `telegramWebhookReceiverRoutes` (public) and `telegramWebhookAdminRoutes` (secured). */
export async function telegramWebhookRoutes(app: FastifyInstance) {
  await telegramWebhookReceiverRoutes(app)
  await telegramWebhookAdminRoutes(app)
}

async function routeToArturita(
  bot: TelegramBot,
  chatId: number,
  text: string,
  orgCtx: { orgId: string; userId: string } | null,
) {
  if (!orgCtx) {
    await bot.sendMessage(chatId, 'Not linked to an org yet. Use /start YOUR-CODE first.')
    return
  }

  await bot.sendChatAction(chatId, 'typing')

  try {
    const result = await runArturitaConverseTurn({
      orgId: orgCtx.orgId,
      authorUser: orgCtx.userId,
      body: { message: text },
    })

    const replyText = String(result.reply?.text ?? '').trim() || NO_LLM_MESSAGE
    const name = result.agent?.name ?? 'Arturita'
    const emoji = result.agent?.avatarEmoji ?? '✨'
    let body = `${emoji} *${name}*\n\n${replyText}`
    if (result.pendingApprovalNote) {
      body += `\n\n_${result.pendingApprovalNote}_`
    }

    if (body.length <= 4000) {
      await bot.sendMessage(chatId, body)
    } else {
      for (let i = 0; i < body.length; i += 4000) {
        const chunk = body.slice(i, i + 4000)
        const prefix = i === 0 ? '' : '…'
        await bot.sendMessage(chatId, prefix + chunk)
      }
    }
  } catch (err: any) {
    await bot.sendMessage(chatId, `❌ Error: ${err.message?.slice(0, 200) ?? 'Arturita could not reply'}`)
  }
}

async function handleCallbackQuery(bot: TelegramBot, query: any) {
  const chatId = query.message?.chat?.id
  const data = query.data as string
  if (!chatId || !data) return

  await bot.answerCallbackQuery(query.id)

  if (data.startsWith('chat_')) {
    const agentId = data.slice(5)
    const orgCtx = await resolveOrgFromChat(chatId)
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (agent && orgCtx) {
      await bot.sendMessage(chatId, `Now chatting with ${agent.avatarEmoji} *${agent.name}*. Send your message:`)
    }
  }
}
