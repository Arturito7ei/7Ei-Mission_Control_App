// MCC-1 — the chat thread's pure logic, the phone's copy of web/lib/chat.logic.ts.
//
// COPIED, not imported: Metro only bundles inside apps/mobile, so the app cannot
// import the web module at runtime. `chat.test.ts` imports BOTH and drives them
// with the same inputs — the parity pin that fails the day these drift.

export interface ChatMsgLite {
  id: string
  role: string
  content: string
  taskId?: string | null
  createdAt: string | number | Date
}

export const msgTime = (m: ChatMsgLite): number => new Date(m.createdAt as any).getTime()

/** Merge a polled window into the on-screen thread: dedupe by id (server copy
 *  wins), order by (createdAt, id) so same-second rows don't flicker. */
export function mergeThread(existing: ChatMsgLite[], incoming: ChatMsgLite[]): ChatMsgLite[] {
  const byId = new Map<string, ChatMsgLite>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => (msgTime(a) - msgTime(b)) || String(a.id).localeCompare(String(b.id)))
}

/** Waiting on the agent? True when the user spoke last — drives the ⏳ row. */
export function awaitingReply(messages: ChatMsgLite[]): boolean {
  if (!messages.length) return false
  return messages[messages.length - 1].role === 'user'
}

/** One-line preview for the agent strip — newest message, squeezed. */
export function threadPreview(messages: ChatMsgLite[], max = 64): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  const flat = String(last.content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Validation mirror of the server's rules — refuse before the round-trip. */
export const MAX_CHAT_CONTENT = 8000
export function chatSendError(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return 'Message is empty.'
  if (trimmed.length > MAX_CHAT_CONTENT) return `Message is too long (max ${MAX_CHAT_CONTENT} characters).`
  return null
}
