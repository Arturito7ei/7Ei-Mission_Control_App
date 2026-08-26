// S6 — labels for the mobile attention queue. Pure data — no React.
// Mirrors web/app/dashboard/cockpit/shared.tsx KIND_LABEL / kind tones.

export const INBOX_KIND_LABEL: Record<string, string> = {
  blocked: '⛔ Blocked',
  failed: '✕ Failed',
  review: 'Review',
  attention: 'ℹ Attention',
}

export type InboxKindTone = 'danger' | 'warn' | 'info'

export function inboxKindTone(kind: string): InboxKindTone {
  if (kind === 'blocked' || kind === 'failed') return 'danger'
  if (kind === 'review') return 'warn'
  return 'info'
}

export function inboxKindLabel(kind: string): string {
  return INBOX_KIND_LABEL[kind] ?? kind
}
