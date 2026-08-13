// Pure helpers for Telegram /start linking policy (CRIT-01).
// Linking requires a one-time bind code from Cockpit — never auto-link first org.

/** Normalize a bind code from `/start <code>` args. Returns null if absent/blank. */
export function normalizeBindCode(raw: string | undefined | null): string | null {
  const code = String(raw ?? '').trim().toUpperCase()
  return code.length > 0 ? code : null
}

/** Instructions when the chat is not yet linked and no bind code was supplied. */
export function unlinkedStartMessage(): string {
  return (
    '🤖 *Welcome to 7Ei Mission Control\\!*\n\n' +
    'This bot does not auto\\-connect to an organisation\\.\n\n' +
    'To link Telegram:\n' +
    '1\\. Open Mission Control → Arturita → *Link Telegram*\n' +
    '2\\. Copy the one\\-time bind code\n' +
    '3\\. Send `/start YOUR\\-CODE` here\n\n' +
    'Codes expire in 10 minutes and are single\\-use\\.'
  )
}

export function bindCodeRejectedMessage(reason: string): string {
  const safe = reason.replace(/[._*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
  return `❌ Link failed: ${safe}\\.\n\nGenerate a fresh code in Mission Control and try \`/start YOUR\\-CODE\` again\\.`
}

export function bindCodeAcceptedMessage(orgName: string): string {
  return (
    `🎯 *Linked to ${orgName.replace(/[._*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')}*\\!\n\n` +
    'Type /help to see available commands\\.'
  )
}
