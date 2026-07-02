// Push notifications — Expo push tokens stored, used for task completion alerts.
// Extracted from routes/notifications.ts so services (agent-executor, scheduler)
// no longer import from a routes module.
export const pushTokens = new Map<string, Set<string>>() // userId → Set<expoToken>

// Called internally when a task completes — sends Expo push notification
export async function sendPushNotification(userId: string, title: string, body: string, data?: Record<string, unknown>) {
  const tokens = pushTokens.get(userId)
  if (!tokens || tokens.size === 0) return

  const messages = Array.from(tokens).map(to => ({ to, title, body, data: data ?? {}, sound: 'default' }))

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
  } catch (e) {
    console.warn('Push notification failed:', e)
  }
}
