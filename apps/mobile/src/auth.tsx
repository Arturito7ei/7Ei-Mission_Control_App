// Auth/session context for the iPhone remote.
//
// PHASE 1 — token-paste auth (this file). The operator pastes a bearer token (a
// Clerk session JWT copied from the web dashboard) + the hosted API URL; we store
// it in the iOS Keychain (expo-secure-store), resolve the org via GET /api/orgs,
// and every screen calls `getToken()` for the bearer. This boots cleanly in Expo
// Go with a plain `npm install` — no native modules, no Clerk peer-dep churn.
//
// PHASE 2 — Clerk-Expo (story MOB-2, stage→audit). Wrap the tree in
// <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={secureCache}>
// and replace `getToken` with Clerk's `useAuth().getToken()` (auto-refreshing).
// The screens don't change — they already depend only on `getToken()` + `orgId`.
// See docs/DESIGN-mobile-expo.md §3. Deferred here because @clerk/clerk-expo does
// not yet install cleanly against the current Expo Go SDK (57 / RN 0.86 / React
// 19.2) without --legacy-peer-deps, which would break the operator's plain
// `npm install`.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Api, type Org } from './api'
import { defaultApiUrl } from './config'
import { clearSession, loadSession, saveSession, type Session } from './store'

type AuthState = {
  ready: boolean // finished loading persisted session
  signedIn: boolean
  apiUrl: string
  token: string | null
  orgId: string | null
  orgName: string | null
  getToken: () => string | null
  // Verify a token+URL, persist it, and return the orgs it can see so the caller
  // can pick one. Throws on an unreachable/invalid combination.
  connect: (token: string, apiUrl: string) => Promise<Org[]>
  chooseOrg: (org: Org) => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    loadSession().then((s) => {
      setSession(s)
      setReady(true)
    })
  }, [])

  const connect = useCallback(async (token: string, apiUrlRaw: string): Promise<Org[]> => {
    const apiUrl = (apiUrlRaw || defaultApiUrl()).trim().replace(/\/+$/, '')
    // Resolve orgs — this both validates the token (401s if bad) and gives us the
    // orgId to scope every subsequent call.
    const orgs = await Api.orgs(apiUrl, token)
    const next: Session = {
      token,
      apiUrl,
      orgId: orgs.length === 1 ? orgs[0].id : null,
      orgName: orgs.length === 1 ? orgs[0].name : null,
    }
    await saveSession(next)
    setSession(next)
    return orgs
  }, [])

  const chooseOrg = useCallback(
    async (org: Org) => {
      if (!session) return
      const next: Session = { ...session, orgId: org.id, orgName: org.name }
      await saveSession(next)
      setSession(next)
    },
    [session],
  )

  const signOut = useCallback(async () => {
    await clearSession()
    setSession(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      ready,
      signedIn: !!session?.token,
      apiUrl: session?.apiUrl || defaultApiUrl(),
      token: session?.token ?? null,
      orgId: session?.orgId ?? null,
      orgName: session?.orgName ?? null,
      getToken: () => session?.token ?? null,
      connect,
      chooseOrg,
      signOut,
    }),
    [ready, session, connect, chooseOrg, signOut],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used within <AuthProvider>')
  return v
}
