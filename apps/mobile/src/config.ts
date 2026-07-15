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

// Present iff the operator supplied a Clerk publishable key (the SAME key the web
// app uses — a non-secret `pk_test_…`/`pk_live_…` that ships in the bundle). When
// set, the app mounts <ClerkProvider> and Clerk becomes the primary sign-in
// (MOB-2). When absent, the app falls back to token-paste (MOB-1) so it always
// boots — Clerk is additive, never a hard requirement.
export const CLERK_PUBLISHABLE_KEY = (process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').trim()

// True when a plausibly-valid Clerk publishable key is configured. We check the
// `pk_` prefix (not just non-empty) so a stray whitespace/placeholder value
// doesn't mount Clerk into a broken state — a malformed key would make
// clerk-js throw at init and wedge the whole app on a blank screen.
export function clerkEnabled(): boolean {
  return CLERK_PUBLISHABLE_KEY.startsWith('pk_')
}
