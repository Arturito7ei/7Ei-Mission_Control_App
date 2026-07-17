// Persistent, encrypted-at-rest storage for the session (auth mode, bearer token,
// API base URL, selected org). Uses expo-secure-store (iOS Keychain / Android
// Keystore) so the bearer token is not left in plaintext. Ships in Expo Go — no
// dev build.
//
// Two auth modes share this store (MOB-2):
//  - 'clerk': Clerk owns the session token in ITS OWN Keychain cache
//    (src/clerkCache.ts); we persist only the mode + apiUrl + selected org here.
//    `token` is absent in this mode — getToken() comes from Clerk, auto-refreshing.
//  - 'paste': the MOB-1 fallback — we persist the pasted bearer token here too.

import * as SecureStore from 'expo-secure-store'

const K = {
  authMode: 'mc.authMode',
  token: 'mc.token',
  apiUrl: 'mc.apiUrl',
  orgId: 'mc.orgId',
  orgName: 'mc.orgName',
  // MOB-7d — the caller's membership role in the selected org ('owner' | 'member'),
  // as `/api/orgs` returns it (`memberRole`). Persisted so owner-only edit surfaces
  // (the agent-settings editor) can gate the affordance without re-fetching. It is
  // NOT an authorisation decision — the backend's owner gate is the real enforcer;
  // this only decides what to OFFER. Absent on pre-MOB-7d sessions → null.
  orgRole: 'mc.orgRole',
} as const

export type AuthMode = 'clerk' | 'paste'

export type Session = {
  authMode: AuthMode
  token: string | null // present only in 'paste' mode
  apiUrl: string
  orgId: string | null
  orgName: string | null
  orgRole: string | null
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
  const [mode, token, apiUrl, orgId, orgName, orgRole] = await Promise.all([
    get(K.authMode),
    get(K.token),
    get(K.apiUrl),
    get(K.orgId),
    get(K.orgName),
    get(K.orgRole),
  ])
  // Back-compat: a MOB-1 session has a token but no authMode → it's a paste session.
  const authMode: AuthMode | null = mode === 'clerk' || mode === 'paste' ? mode : token ? 'paste' : null
  if (!authMode) return null
  // A paste session with no token is meaningless — treat as no session.
  if (authMode === 'paste' && !token) return null
  // orgRole is absent on pre-MOB-7d sessions → null (editing stays gated until the
  // next org resolve writes it, which fail-closes correctly).
  return { authMode, token: authMode === 'paste' ? token : null, apiUrl: apiUrl ?? '', orgId, orgName, orgRole }
}

export async function saveSession(s: Session): Promise<void> {
  await Promise.all([
    set(K.authMode, s.authMode),
    set(K.token, s.authMode === 'paste' ? s.token : null),
    set(K.apiUrl, s.apiUrl),
    set(K.orgId, s.orgId),
    set(K.orgName, s.orgName),
    set(K.orgRole, s.orgRole),
  ])
}

export async function clearSession(): Promise<void> {
  await Promise.all(Object.values(K).map((k) => set(k, null)))
}
