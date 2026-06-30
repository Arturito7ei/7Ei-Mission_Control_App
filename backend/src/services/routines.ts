// Routines+ (MCA-PC C3). Pure helpers for trigger sources beyond cron
// (webhook + API). Each trigger fires a routine which creates a tracked task.
import { randomBytes } from 'crypto'

export type TriggerType = 'cron' | 'webhook' | 'api'

/** Opaque token used in the public webhook-trigger URL. */
export function makeWebhookToken(): string {
  return 'rt_' + randomBytes(24).toString('hex')
}

/** Whether a routine is fired by the cron scheduler (default/back-compat). */
export function isCronTriggered(triggerType: string | null | undefined): boolean {
  return !triggerType || triggerType === 'cron'
}

/** Validate a requested trigger type. */
export function normalizeTriggerType(t: string | null | undefined): TriggerType {
  return t === 'webhook' || t === 'api' ? t : 'cron'
}

/** Sentinel stored in the NOT NULL cron column for non-cron routines. */
export function cronSentinel(triggerType: TriggerType): string {
  return triggerType === 'cron' ? '' : `@${triggerType}`
}
