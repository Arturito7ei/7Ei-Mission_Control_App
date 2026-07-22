// MCC-1 — pure chat-thread logic for the Chat surface (web has no jest/vitest;
// these run under node --test). Kept out of the component so merging and the
// awaiting-reply decision are unit-tested without React.

export interface ChatMsg {
  id: string
  role: string
  content: string
  taskId?: string | null
  /** MCC-2 — Clerk user id of the human who wrote a user-role row. Null on
   *  assistant rows and on legacy/webhook rows. */
  authorUser?: string | null
  createdAt: string | number | Date
}

/**
 * MCC-2 — label for a user-role row. The thread is org-shared, so "You" is only
 * honest when the row's author IS the viewer; anything else (another member, a
 * legacy row, a webhook-injected row) is "Member". Fail toward "Member": a row
 * that can't prove it's yours must not claim to be.
 */
export function authorLabel(m: ChatMsg, viewer: string | null | undefined): 'You' | 'Member' {
  return m.authorUser && viewer && m.authorUser === viewer ? 'You' : 'Member'
}

export const msgTime = (m: ChatMsg): number => new Date(m.createdAt as any).getTime()

const ROLE_ORDER: Record<string, number> = { user: 0, assistant: 1 }

/**
 * Merge a freshly-polled window into what's on screen, deduped by id. Dedupe
 * matters twice: the optimistic append after POST reappears in the next poll,
 * and consecutive newest-N windows overlap almost entirely.
 *
 * Ordering: (createdAt, then question-before-answer within a task, then id).
 * The server stores createdAt at SECOND precision, so a Q/A pair routinely
 * shares a timestamp — and message ids are random UUIDs, useless as a
 * tie-break (audit MCC-1 #1). Within one taskId the user's question always
 * precedes the assistant's answer, which mirrors the server's rowid order.
 */
export function mergeThread(existing: ChatMsg[], incoming: ChatMsg[]): ChatMsg[] {
  const byId = new Map<string, ChatMsg>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m) // server copy wins over optimistic
  return [...byId.values()].sort((a, b) => {
    const dt = msgTime(a) - msgTime(b)
    if (dt) return dt
    if (a.taskId && a.taskId === b.taskId) {
      const dr = (ROLE_ORDER[a.role] ?? 2) - (ROLE_ORDER[b.role] ?? 2)
      if (dr) return dr
    }
    return String(a.id).localeCompare(String(b.id))
  })
}

/**
 * Is the thread waiting on the agent? True when the newest message is the
 * user's. Drives the "…awaiting reply" indicator for external runtimes — their
 * answer arrives via their poll loop, seconds-to-minutes later.
 */
export function awaitingReply(messages: ChatMsg[]): boolean {
  if (!messages.length) return false
  return messages[messages.length - 1].role === 'user'
}

/** One-line preview for the agent list — newest message, squeezed. */
export function threadPreview(messages: ChatMsg[], max = 64): string {
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
