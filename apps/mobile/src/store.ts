// Persistent, encrypted-at-rest storage for the session (bearer token, API base
// URL, selected org). Uses expo-secure-store (iOS Keychain / Android Keystore) so
// the bearer token is not left in plaintext. Ships in Expo Go — no dev build.

import * as SecureStore from 'expo-secure-store'

const K = {
  token: 'mc.token',
  apiUrl: 'mc.apiUrl',
  orgId: 'mc.orgId',
  orgName: 'mc.orgName',
} as const

export type Session = {
  token: string
  apiUrl: string
  orgId: string | null
  orgName: string | null
}

async function get(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key)
  } catch {
    return null
  }
}

async function set(key: string, value: string | null): Promise<void> {
  try {
    if (value == null) await SecureStore.deleteItemAsync(key)
    else await SecureStore.setItemAsync(key, value)
  } catch {
    // Non-fatal: a storage failure just means the session won't persist across
    // restarts. The in-memory session still works for this run.
  }
}

export async function loadSession(): Promise<Session | null> {
  const token = await get(K.token)
  if (!token) return null
  return {
    token,
    apiUrl: (await get(K.apiUrl)) ?? '',
    orgId: await get(K.orgId),
    orgName: await get(K.orgName),
  }
}

export async function saveSession(s: Session): Promise<void> {
  await set(K.token, s.token)
  await set(K.apiUrl, s.apiUrl)
  await set(K.orgId, s.orgId)
  await set(K.orgName, s.orgName)
}

export async function clearSession(): Promise<void> {
  await Promise.all(Object.values(K).map((k) => set(k, null)))
}
