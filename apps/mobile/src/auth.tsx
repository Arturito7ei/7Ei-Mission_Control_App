// Auth/session context for the iPhone remote.
//
// TWO auth modes share one context (MOB-2):
//
//   • CLERK (primary) — when EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is set, the app is a
//     native Clerk client of the SAME Clerk instance the web app uses. Sign-in is a
//     real Clerk flow (ConnectScreen), the session lives in the iOS Keychain via
//     Clerk's tokenCache (src/clerkCache.ts), and getToken() returns a fresh,
//     auto-refreshing session JWT per call — so no 401-on-expiry. The backend's
//     existing clerkAuth + org-membership gates apply unchanged.
//
//   • PASTE (fallback, MOB-1) — when no Clerk key is configured, or the operator
//     chooses "use a token instead", they paste a bearer token; we store it in the
//     Keychain (src/store.ts) and use it directly. This guarantees the app always
//     boots even without Clerk configured, and is the documented escape hatch.
//
// Screens depend only on `getToken()` (now async) + `orgId` + `apiUrl`, so the two
// modes are invisible to them. Org scoping is mode-agnostic and persisted in the
// store; the token SOURCE is the only thing that differs between modes.
//
// See docs/DESIGN-mobile-expo.md §2.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ClerkProvider, useAuth as useClerkAuth, useUser } from '@clerk/clerk-expo'
import { Api, type Org } from './api'
import { secureTokenCache } from './clerkCache'
import { CLERK_PUBLISHABLE_KEY, clerkEnabled, defaultApiUrl } from './config'
import { clearSession, loadSession, saveSession, type AuthMode, type Session } from './store'

export type { AuthMode }

type AuthState = {
  ready: boolean // finished loading persisted session (and Clerk, in Clerk mode)
  clerkEnabled: boolean // a Clerk publishable key is configured → show Clerk sign-in
  clerkSignedIn: boolean // signed in via Clerk (identity established, org maybe not yet)
  signedIn: boolean // has a usable token source (Clerk session OR pasted token)
  authMode: AuthMode | null
  identityLabel: string | null // e.g. the signed-in Clerk user's email, for Status
  // The signed-in user's Clerk id (the JWT `sub`). Used by push registration:
  // the backend targets pushes at `org.ownerId`, so the phone must register its
  // Expo token under this id. In Clerk mode it comes from useUser(); in paste
  // mode we best-effort decode the `sub` claim of the pasted JWT. Null if unknown
  // (→ push registration is skipped with a clear reason, never guessed).
  userId: string | null
  apiUrl: string
  token: string | null // paste-mode bearer (null in Clerk mode — token comes from getToken)
  orgId: string | null
  orgName: string | null
  // Async: in Clerk mode this mints a fresh, auto-refreshing JWT; in paste mode it
  // returns the stored bearer. Screens await this before every API call.
  getToken: () => Promise<string | null>
  // PASTE path: verify a token+URL, persist it, and return the orgs it can see.
  connect: (token: string, apiUrl: string) => Promise<Org[]>
  // CLERK path: after sign-in, resolve the backend orgs the Clerk user can see and
  // persist the mode + apiUrl + (auto-selected) org.
  resolveClerkOrgs: (apiUrl?: string) => Promise<Org[]>
  chooseOrg: (org: Org) => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

// Best-effort extraction of the Clerk user id (`sub`) from a session JWT, for
// paste mode (Clerk mode gets the id from useUser()). Pure client-side decode of
// the *unverified* payload — we only use it as a push-registration key, never for
// an authz decision (the backend validates the real token). Returns null on any
// malformed input rather than throwing. Uses the Hermes global `atob` when
// present; if base64 decoding isn't available, we simply skip (userId stays null,
// push registration is skipped honestly). NEVER logs the token.
function decodeJwtSub(jwt: string | null | undefined): string | null {
  if (!jwt) return null
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  const g = globalThis as unknown as { atob?: (s: string) => string }
  if (typeof g.atob !== 'function') return null
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const payload = JSON.parse(g.atob(b64)) as { sub?: unknown }
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null
  } catch {
    return null
  }
}

// ─── Shared persisted-session state + mode-agnostic operations ──────────────────

function useSessionStore() {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    loadSession().then((s) => {
      setSession(s)
      setReady(true)
    })
  }, [])

  const persist = useCallback(async (next: Session | null) => {
    if (next) await saveSession(next)
    else await clearSession()
    setSession(next)
  }, [])

  return { ready, session, setSession, persist }
}

// ─── Paste-only provider (no Clerk key configured) ──────────────────────────────

function PasteAuthProvider({ children }: { children: React.ReactNode }) {
  const { ready, session, persist } = useSessionStore()

  const connect = useCallback(
    async (token: string, apiUrlRaw: string): Promise<Org[]> => {
      const apiUrl = (apiUrlRaw || defaultApiUrl()).trim().replace(/\/+$/, '')
      const orgs = await Api.orgs(apiUrl, token) // validates the token (401 if bad)
      await persist({
        authMode: 'paste',
        token,
        apiUrl,
        orgId: orgs.length === 1 ? orgs[0].id : null,
        orgName: orgs.length === 1 ? orgs[0].name : null,
      })
      return orgs
    },
    [persist],
  )

  const chooseOrg = useCallback(
    async (org: Org) => {
      if (!session) return
      await persist({ ...session, orgId: org.id, orgName: org.name })
    },
    [session, persist],
  )

  const signOut = useCallback(async () => {
    await persist(null)
  }, [persist])

  const value = useMemo<AuthState>(
    () => ({
      ready,
      clerkEnabled: false,
      clerkSignedIn: false,
      signedIn: !!session?.token,
      authMode: session?.authMode ?? null,
      identityLabel: null,
      userId: decodeJwtSub(session?.token),
      apiUrl: session?.apiUrl || defaultApiUrl(),
      token: session?.token ?? null,
      orgId: session?.orgId ?? null,
      orgName: session?.orgName ?? null,
      getToken: async () => session?.token ?? null,
      connect,
      resolveClerkOrgs: async () => [],
      chooseOrg,
      signOut,
    }),
    [ready, session, connect, chooseOrg, signOut],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// ─── Clerk provider (a Clerk key is configured) ─────────────────────────────────
// Always rendered INSIDE <ClerkProvider>, so Clerk hooks are safe to call. Supports
// Clerk sign-in as the primary path AND the pasted-token escape hatch.

function ClerkAuthBridge({ children }: { children: React.ReactNode }) {
  const { ready: storeReady, session, persist } = useSessionStore()
  const clerk = useClerkAuth() // { isLoaded, isSignedIn, getToken, signOut }
  const { user } = useUser()

  const clerkSignedIn = !!clerk.isSignedIn
  const ready = storeReady && clerk.isLoaded

  // getToken: Clerk session token when signed in via Clerk (auto-refreshing),
  // otherwise the stored paste bearer. NEVER logs the token.
  const getToken = useCallback(async (): Promise<string | null> => {
    if (clerkSignedIn) {
      try {
        return (await clerk.getToken()) ?? null
      } catch {
        return null
      }
    }
    return session?.token ?? null
  }, [clerkSignedIn, clerk, session?.token])

  // Resolve backend orgs for the just-signed-in Clerk user and persist the session.
  const resolveClerkOrgs = useCallback(
    async (apiUrlRaw?: string): Promise<Org[]> => {
      const apiUrl = (apiUrlRaw || session?.apiUrl || defaultApiUrl()).trim().replace(/\/+$/, '')
      const jwt = await clerk.getToken()
      if (!jwt) throw new Error('Not signed in to Clerk yet.')
      const orgs = await Api.orgs(apiUrl, jwt)
      await persist({
        authMode: 'clerk',
        token: null,
        apiUrl,
        orgId: orgs.length === 1 ? orgs[0].id : null,
        orgName: orgs.length === 1 ? orgs[0].name : null,
      })
      return orgs
    },
    [clerk, session?.apiUrl, persist],
  )

  // Paste escape hatch, still available even with Clerk configured.
  const connect = useCallback(
    async (token: string, apiUrlRaw: string): Promise<Org[]> => {
      const apiUrl = (apiUrlRaw || defaultApiUrl()).trim().replace(/\/+$/, '')
      const orgs = await Api.orgs(apiUrl, token)
      await persist({
        authMode: 'paste',
        token,
        apiUrl,
        orgId: orgs.length === 1 ? orgs[0].id : null,
        orgName: orgs.length === 1 ? orgs[0].name : null,
      })
      return orgs
    },
    [persist],
  )

  const chooseOrg = useCallback(
    async (org: Org) => {
      // authMode is 'clerk' once signed in via Clerk; else preserve the paste session.
      const base: Session = session ?? {
        authMode: clerkSignedIn ? 'clerk' : 'paste',
        token: null,
        apiUrl: defaultApiUrl(),
        orgId: null,
        orgName: null,
      }
      await persist({
        ...base,
        authMode: clerkSignedIn ? 'clerk' : base.authMode,
        orgId: org.id,
        orgName: org.name,
      })
    },
    [session, clerkSignedIn, persist],
  )

  const signOut = useCallback(async () => {
    if (clerkSignedIn) {
      try {
        await clerk.signOut()
      } catch {
        // Even if Clerk's sign-out call fails, clear our local scoping below.
      }
    }
    await persist(null)
  }, [clerkSignedIn, clerk, persist])

  // Which persisted orgId is valid for the CURRENT token source. Signing in via
  // Clerk over an old paste session must NOT inherit that session's org — force a
  // re-resolve until a 'clerk' session is written.
  const effectiveSession =
    clerkSignedIn && session?.authMode !== 'clerk' ? null : session

  const value = useMemo<AuthState>(
    () => ({
      ready,
      clerkEnabled: true,
      clerkSignedIn,
      signedIn: clerkSignedIn || !!session?.token,
      authMode: clerkSignedIn ? 'clerk' : (session?.authMode ?? null),
      identityLabel:
        user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null,
      // Clerk id from the signed-in user; else the pasted token's sub (escape hatch).
      userId: clerkSignedIn ? (user?.id ?? null) : decodeJwtSub(session?.token),
      apiUrl: effectiveSession?.apiUrl || defaultApiUrl(),
      token: clerkSignedIn ? null : (session?.token ?? null),
      orgId: effectiveSession?.orgId ?? null,
      orgName: effectiveSession?.orgName ?? null,
      getToken,
      connect,
      resolveClerkOrgs,
      chooseOrg,
      signOut,
    }),
    [ready, clerkSignedIn, session, effectiveSession, user, getToken, connect, resolveClerkOrgs, chooseOrg, signOut],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// ─── Public provider — picks the implementation from config ─────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (clerkEnabled()) {
    return (
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={secureTokenCache}>
        <ClerkAuthBridge>{children}</ClerkAuthBridge>
      </ClerkProvider>
    )
  }
  return <PasteAuthProvider>{children}</PasteAuthProvider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used within <AuthProvider>')
  return v
}
