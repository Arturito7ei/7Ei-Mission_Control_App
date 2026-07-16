// Clerk token cache backed by expo-secure-store (iOS Keychain / Android Keystore).
//
// Clerk keeps the active session token in memory by default; on a phone the
// recommended durable store is the OS secure enclave, NOT AsyncStorage/plaintext.
// This cache lets Clerk persist its session across app restarts encrypted at rest,
// exactly like the phase-1 paste bearer (src/store.ts) — same Keychain posture.
//
// Security invariants (MOB-2 stage→audit):
// - Tokens live only in the Keychain; never in JS-readable storage, never in a log.
// - We do NOT console.log keys or values here. Do not add logging that prints them.
// - SecureStore keys are restricted to [A-Za-z0-9._-]; Clerk's cache keys already
//   satisfy that, but we defensively sanitise so an unexpected key can't throw.

import * as SecureStore from 'expo-secure-store'
import type { TokenCache } from '@clerk/clerk-expo'

function safeKey(key: string): string {
  // Keep it stable and collision-free while dropping any disallowed character.
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

export const secureTokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(safeKey(key))
    } catch {
      // A read failure (e.g. Keychain unavailable) is non-fatal: Clerk falls back
      // to its in-memory session for this run and re-auth happens on next launch.
      return null
    }
  },
  async saveToken(key: string, token: string) {
    try {
      await SecureStore.setItemAsync(safeKey(key), token)
    } catch {
      // Non-fatal: the session just won't persist across restarts.
    }
  },
  async clearToken(key: string) {
    try {
      await SecureStore.deleteItemAsync(safeKey(key))
    } catch {
      // Non-fatal.
    }
  },
}
