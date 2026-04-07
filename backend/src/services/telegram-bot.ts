// ─── Telegram Bot API Wrapper ──────────────────────────────────────────────────
// Pure HTTP wrapper — no external library needed.
// Supports sendMessage (MarkdownV2), typing indicators, webhooks.

const TELEGRAM_API = 'https://api.telegram.org'

export class TelegramBot {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  private async call(method: string, body: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as any
    if (!data.ok) {
      console.warn(`Telegram API error (${method}):`, data.description)
    }
    return data
  }

  async sendMessage(chatId: number | string, text: string, opts?: {
    parseMode?: 'MarkdownV2' | 'HTML'
    replyMarkup?: any
    disableWebPagePreview?: boolean
  }): Promise<any> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts?.parseMode,
      reply_markup: opts?.replyMarkup,
      disable_web_page_preview: opts?.disableWebPagePreview,
    })
  }

  async sendChatAction(chatId: number | string, action: 'typing' | 'upload_document' | 'upload_photo' = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action })
  }

  async sendDocument(chatId: number | string, documentUrl: string, caption?: string): Promise<any> {
    return this.call('sendDocument', {
      chat_id: chatId,
      document: documentUrl,
      caption,
    })
  }

  async sendPhoto(chatId: number | string, photoUrl: string, caption?: string): Promise<any> {
    return this.call('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption,
    })
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    })
  }

  async setWebhook(url: string, secretToken?: string): Promise<any> {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 40,
    })
  }

  async deleteWebhook(): Promise<any> {
    return this.call('deleteWebhook')
  }

  async getWebhookInfo(): Promise<any> {
    return this.call('getWebhookInfo')
  }
}

// Escape text for Telegram MarkdownV2 format
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

// Convert plain agent response to MarkdownV2
export function formatAgentResponse(agentName: string, agentEmoji: string, text: string): string {
  const header = `${agentEmoji} *${escapeMarkdownV2(agentName)}*`
  const body = escapeMarkdownV2(text)
  return `${header}\n\n${body}`
}

// Create inline keyboard from array of buttons
export function inlineKeyboard(buttons: Array<{ text: string; callbackData: string }>): any {
  return {
    inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.callbackData }))],
  }
}

// Create keyboard rows (max 3 per row)
export function inlineKeyboardRows(buttons: Array<{ text: string; callbackData: string }>, perRow = 2): any {
  const rows: any[][] = []
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow).map(b => ({ text: b.text, callback_data: b.callbackData })))
  }
  return { inline_keyboard: rows }
}
