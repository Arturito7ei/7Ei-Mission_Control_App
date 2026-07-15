// Runtime configuration.
//
// The phone is a THIN REMOTE CLIENT to the HOSTED backend — it talks to the same
// REST API the web dashboard uses (https://7ei-backend.fly.dev). It does NOT
// connect to the operator's Mac mini; the Mac-mini agents keep reporting to the
// hosted backend, and the phone reads/controls through the hosted API.
//
// Native RN apps send no `Origin` header, so the backend CORS allow-list does not
// gate the phone — it can reach the hosted API as-is. (Expo *web* dev at
// localhost:8081 IS on the allow-list, so web preview works too.)
//
// Override the base URL with EXPO_PUBLIC_API_URL (e.g. a staging/tunnel host).
// EXPO_PUBLIC_* vars are inlined by Expo at build time and are safe for non-secret
// config only.

export const DEFAULT_API_URL = 'https://7ei-backend.fly.dev'

export function defaultApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL
  return fromEnv && fromEnv.trim() ? fromEnv.trim().replace(/\/+$/, '') : DEFAULT_API_URL
}

// Present iff the operator supplied a Clerk publishable key. Phase 1 ships
// token-paste auth; Clerk-Expo (story MOB-2) reads this to mount its provider.
export const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''
