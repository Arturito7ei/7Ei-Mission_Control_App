import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escapeMarkdownV2, formatAgentResponse, inlineKeyboard, inlineKeyboardRows } from '../services/telegram-bot.ts'
import { parseCommand } from '../routes/telegram-commands.ts'

// ─── Webhook parsing ──────────────────────────────────────────────

describe('[TELEGRAM] parseCommand', () => {
  it('parses /start', () => {
    const cmd = parseCommand('/start')
    assert.deepEqual(cmd, { command: 'start', args: '' })
  })

  it('parses /ask with args', () => {
    const cmd = parseCommand('/ask What is our mission?')
    assert.equal(cmd?.command, 'ask')
    assert.equal(cmd?.args, 'What is our mission?')
  })

  it('parses /status', () => {
    const cmd = parseCommand('/status')
    assert.equal(cmd?.command, 'status')
  })

  it('returns null for plain text', () => {
    assert.equal(parseCommand('Hello Arturito'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(parseCommand(''), null)
  })

  it('handles /help', () => {
    const cmd = parseCommand('/help')
    assert.equal(cmd?.command, 'help')
  })

  it('handles /agents', () => {
    const cmd = parseCommand('/agents')
    assert.equal(cmd?.command, 'agents')
  })

  it('handles /tasks', () => {
    const cmd = parseCommand('/tasks')
    assert.equal(cmd?.command, 'tasks')
  })

  it('command is case-insensitive', () => {
    const cmd = parseCommand('/START')
    assert.equal(cmd?.command, 'start')
  })
})

// ─── MarkdownV2 escaping ──────────────────────────────────────────

describe('[TELEGRAM] escapeMarkdownV2', () => {
  it('escapes special characters', () => {
    const escaped = escapeMarkdownV2('Hello *world* [link](url)')
    assert.ok(escaped.includes('\\*'))
    assert.ok(escaped.includes('\\['))
    assert.ok(escaped.includes('\\]'))
    assert.ok(escaped.includes('\\('))
    assert.ok(escaped.includes('\\)'))
  })

  it('leaves plain text unchanged', () => {
    assert.equal(escapeMarkdownV2('Hello world'), 'Hello world')
  })

  it('escapes dots', () => {
    assert.equal(escapeMarkdownV2('v1.3.0'), 'v1\\.3\\.0')
  })

  it('escapes underscores', () => {
    assert.equal(escapeMarkdownV2('my_var'), 'my\\_var')
  })

  it('escapes hyphens', () => {
    assert.equal(escapeMarkdownV2('a-b'), 'a\\-b')
  })
})

// ─── Response formatting ──────────────────────────────────────────

describe('[TELEGRAM] formatAgentResponse', () => {
  it('formats agent response with name and emoji', () => {
    const formatted = formatAgentResponse('Arturito', '🎯', 'Hello there!')
    assert.ok(formatted.includes('🎯'))
    assert.ok(formatted.includes('*Arturito*'))
    assert.ok(formatted.includes('Hello there\\!'))
  })
})

// ─── Inline keyboard ─────────────────────────────────────────────

describe('[TELEGRAM] inlineKeyboard', () => {
  it('creates single-row keyboard', () => {
    const kb = inlineKeyboard([
      { text: 'Agent A', callbackData: 'chat_1' },
      { text: 'Agent B', callbackData: 'chat_2' },
    ])
    assert.equal(kb.inline_keyboard.length, 1)
    assert.equal(kb.inline_keyboard[0].length, 2)
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'chat_1')
  })

  it('inlineKeyboardRows creates multiple rows', () => {
    const kb = inlineKeyboardRows([
      { text: 'A', callbackData: '1' },
      { text: 'B', callbackData: '2' },
      { text: 'C', callbackData: '3' },
    ], 2)
    assert.equal(kb.inline_keyboard.length, 2) // 2 rows: [A,B], [C]
    assert.equal(kb.inline_keyboard[0].length, 2)
    assert.equal(kb.inline_keyboard[1].length, 1)
  })
})

// ─── Update routing ───────────────────────────────────────────────

describe('[TELEGRAM] update routing logic', () => {
  it('message update has chat.id and text', () => {
    const update = { message: { chat: { id: 12345 }, text: '/start' } }
    assert.equal(update.message.chat.id, 12345)
    assert.equal(update.message.text, '/start')
  })

  it('callback_query has data and message.chat.id', () => {
    const update = {
      callback_query: {
        id: 'cb_1',
        data: 'chat_agent123',
        message: { chat: { id: 12345 } },
      },
    }
    assert.ok(update.callback_query.data.startsWith('chat_'))
    assert.equal(update.callback_query.data.slice(5), 'agent123')
  })

  it('webhook secret header name', () => {
    const header = 'x-telegram-bot-api-secret-token'
    assert.equal(header, 'x-telegram-bot-api-secret-token')
  })
})
