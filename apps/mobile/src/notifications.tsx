// Push notifications for the iPhone remote (MOB-3).
//
// TWO layers, split by what Expo Go can do vs what needs an EAS dev build:
//
//   • Works in EXPO GO now (no dev build):
//       – a foreground notification handler (banner + sound while the app is open),
//       – permission request,
//       – LOCAL/scheduled notifications (the "Send a test" button) — this proves the
//         handler + tap-routing wiring end-to-end without any remote delivery,
//       – tapping a notification deep-links to the right tab (e.g. approval → Inbox).
//
//   • Needs an EAS DEV BUILD (staged, flag-gated by EXPO_PUBLIC_EAS_PROJECT_ID):
//       – a remote Expo push token (getExpoPushTokenAsync needs a projectId),
//       – registering that token with the hosted backend so REMOTE pushes arrive.
//     With no projectId (the Expo Go default) we skip the token step gracefully —
//     no throw — and the UI clearly says "remote delivery needs a dev build".
//
// The backend register endpoint (POST /api/notifications/register) is user-scoped
// and keys on the body `userId` (= the signed-in Clerk id / JWT sub), because the
// backend targets pushes at `org.ownerId`. We NEVER log the Expo push token.
//
// See docs/DESIGN-mobile-expo.md §4 and §14 (MOB-3 as-built).

// TYPE-only: erased at compile time. A VALUE import of expo-notifications is
// itself a native side effect — its module body resolves
// requireNativeModule('ExpoNotificationsHandlerModule') AND constructs a
// LegacyEventEmitter over it at module scope. Since App.tsx imports this file,
// that ran at BOOT: a host that doesn't carry the module would throw during module
// evaluation and blank the app before React mounts (where the ErrorBoundary can't
// reach). Pulled in lazily at each point of use instead.
import type * as NotificationsNS from 'expo-notifications'
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Api } from './api'
import { useAuth } from './auth'
import { EAS_PROJECT_ID, pushRemoteConfigured } from './config'
import { lazyNativeModule } from './nativeModule'

const getNotifications = lazyNativeModule(
  'expo-notifications',
  () => require('expo-notifications') as typeof NotificationsNS,
)

// Where a notification tap should land. Kept in sync with App.tsx's TabKey.
export type PushRouteTarget = 'command' | 'inbox' | 'agents' | 'status'

// Foreground behaviour — show a banner + play a sound even when the app is open,
// so an approval-needed push is visible while you're already in the app.
//
// This USED to run at module load, per Expo's guidance. It no longer does: a
// top-level call into a native module is a boot-path throw waiting to happen, and
// module load is exactly where such a throw is invisible (no render → no
// ErrorBoundary → white screen). PushProvider now installs it from an effect, which
// still lands well before any notification can arrive — the handler only matters
// once a push is delivered, and the provider mounts at sign-in. Idempotent, and
// fail-soft: no notifications module simply means no foreground handler.
function installForegroundHandler(): void {
  const N = getNotifications()
  if (!N) return
  try {
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    })
  } catch (e) {
    console.warn('[7Ei] could not install the foreground notification handler:', e)
  }
}

type PermState = 'granted' | 'denied' | 'undetermined' | 'unknown'

export type PushStatus = {
  permission: PermState
  remoteConfigured: boolean // an EAS projectId is set → remote tokens are possible
  tokenObtained: boolean // getExpoPushTokenAsync succeeded (implies remoteConfigured)
  registered: boolean // the token was accepted by the backend register endpoint
  tokenTail: string | null // last 4 chars only, for the UI — never the whole token
  userKnown: boolean // we have a userId to register under
  busy: boolean
  error: string | null
}

const INITIAL: PushStatus = {
  permission: 'unknown',
  remoteConfigured: pushRemoteConfigured(),
  tokenObtained: false,
  registered: false,
  tokenTail: null,
  userKnown: false,
  busy: false,
  error: null,
}

export type PushApi = {
  status: PushStatus
  // User-initiated: request permission (if needed) then obtain + register the token.
  // Safe to call in Expo Go — it grants permission and enables local test, and
  // simply reports "remote needs a dev build" when no projectId is configured.
  enable: () => Promise<void>
  // De-register this device's token from the backend. Call this from the sign-out
  // flow *before* clearing the session, while the Clerk bearer is still valid (the
  // register endpoint is auth-gated, so a post-sign-out DELETE would 401). Idempotent.
  deregister: () => Promise<void>
  // Prove the handler + routing wiring without remote delivery: schedule a local
  // notification a moment out. Works in Expo Go.
  sendTest: () => Promise<void>
}

const Ctx = createContext<PushApi | null>(null)

async function readPermission(): Promise<PermState> {
  const Notifications = getNotifications()
  if (!Notifications) return 'unknown'
  try {
    const p = await Notifications.getPermissionsAsync()
    if (p.granted) return 'granted'
    return p.status === 'denied' ? 'denied' : 'undetermined'
  } catch {
    return 'unknown'
  }
}

// Obtain a remote Expo push token — ONLY when a projectId is configured. In Expo
// Go without one, this is a no-op returning null (never throws), which is the
// whole "graceful in Expo Go" contract.
async function obtainExpoToken(): Promise<string | null> {
  if (!pushRemoteConfigured()) return null
  const Notifications = getNotifications()
  if (!Notifications) return null
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })
    return t?.data ?? null
  } catch {
    // getExpoPushTokenAsync can throw on a simulator or a misconfigured project —
    // treat as "no remote token", never crash the app.
    return null
  }
}

export function PushProvider({ children }: { children: React.ReactNode }) {
  const { signedIn, orgId, userId, apiUrl, getToken } = useAuth()
  const enabled = signedIn && !!orgId

  const [status, setStatus] = useState<PushStatus>(() => ({
    ...INITIAL,
    userKnown: !!userId,
  }))

  // Install the foreground handler here rather than at module load — see
  // installForegroundHandler. Once per mount; the call is idempotent.
  useEffect(() => {
    installForegroundHandler()
  }, [])

  // What we last registered, so we can de-register exactly on sign-out / change.
  const registeredRef = useRef<{ apiUrl: string; userId: string; token: string } | null>(null)

  const patch = useCallback((p: Partial<PushStatus>) => setStatus((s) => ({ ...s, ...p })), [])

  // Register the given Expo token with the backend under `userId`. Replaces any
  // previously-registered token for this session (de-registers the stale one).
  const registerToken = useCallback(
    async (token: string, uid: string, base: string): Promise<boolean> => {
      const prev = registeredRef.current
      const bearer = await getToken().catch(() => null)
      try {
        await Api.registerPush(base, uid, token, bearer)
        // If we had a different token registered, clean it up (best-effort).
        if (prev && (prev.token !== token || prev.userId !== uid)) {
          Api.unregisterPush(prev.apiUrl, prev.userId, prev.token, bearer).catch(() => {})
        }
        registeredRef.current = { apiUrl: base, userId: uid, token }
        return true
      } catch (e: any) {
        patch({ error: e?.message ?? 'Could not register for push.' })
        return false
      }
    },
    [getToken, patch],
  )

  // Core flow. `request` = may we prompt for permission (user-initiated) or only
  // read the current grant (auto, on sign-in)?
  const run = useCallback(
    async (request: boolean) => {
      patch({ busy: true, error: null, userKnown: !!userId })
      try {
        let perm = await readPermission()
        if (perm !== 'granted' && request) {
          try {
            const N = getNotifications()
            const r = await N?.requestPermissionsAsync()
            perm = !r
              ? 'unknown'
              : r.granted
                ? 'granted'
                : r.status === 'denied'
                  ? 'denied'
                  : 'undetermined'
          } catch {
            perm = 'unknown'
          }
        }
        patch({ permission: perm, remoteConfigured: pushRemoteConfigured() })

        if (perm !== 'granted') {
          patch({ tokenObtained: false, registered: false, tokenTail: null })
          return
        }

        // Remote token: only when a projectId exists AND we know who to register.
        const token = await obtainExpoToken()
        if (!token) {
          // Expo Go (no projectId) or token unavailable — local notifications still
          // work; remote is gated behind the dev build.
          patch({ tokenObtained: false, registered: false, tokenTail: null })
          return
        }
        const tail = token.slice(-5, -1) // inside the trailing "]"
        patch({ tokenObtained: true, tokenTail: tail })

        if (!userId) {
          patch({ registered: false })
          return
        }
        const ok = await registerToken(token, userId, apiUrl)
        patch({ registered: ok })
      } finally {
        patch({ busy: false })
      }
    },
    [patch, userId, apiUrl, registerToken],
  )

  // Auto path: on sign-in (and when the user/org/url changes), if permission is
  // already granted, obtain + register silently. Do NOT auto-prompt — the first
  // permission request is user-initiated via `enable()` so it isn't a surprise.
  useEffect(() => {
    if (!enabled) return
    run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, apiUrl])

  // Best-effort backstop: if we become disabled without an explicit deregister()
  // (e.g. session invalidated elsewhere), drop local push state and attempt an
  // unregister. The register endpoint is auth-gated, so a bearer-less DELETE here
  // may 401 — that's why the primary sign-out path calls deregister() first, while
  // the bearer is still valid. Either way we clear local state so the UI is honest.
  useEffect(() => {
    if (enabled) return
    const prev = registeredRef.current
    if (prev) {
      Api.unregisterPush(prev.apiUrl, prev.userId, prev.token, null).catch(() => {})
      registeredRef.current = null
      setStatus((s) => ({ ...s, registered: false, tokenObtained: false, tokenTail: null }))
    }
  }, [enabled])

  const enable = useCallback(() => run(true), [run])

  // Explicit de-register, using a still-valid bearer (call before sign-out).
  const deregister = useCallback(async () => {
    const prev = registeredRef.current
    if (!prev) return
    const bearer = await getToken().catch(() => null)
    await Api.unregisterPush(prev.apiUrl, prev.userId, prev.token, bearer).catch(() => {})
    registeredRef.current = null
    patch({ registered: false, tokenObtained: false, tokenTail: null })
  }, [getToken, patch])

  const sendTest = useCallback(async () => {
    patch({ error: null })
    const Notifications = getNotifications()
    if (!Notifications) {
      patch({ error: "This app build can't send notifications." })
      return
    }
    try {
      let perm = await readPermission()
      if (perm !== 'granted') {
        const r = await Notifications.requestPermissionsAsync()
        perm = r.granted ? 'granted' : 'denied'
        patch({ permission: perm })
      }
      if (perm !== 'granted') {
        patch({ error: 'Notifications are not permitted. Enable them in iOS Settings.' })
        return
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '7Ei — test notification',
          body: 'If you tap this, it opens the Inbox. Handler + routing wiring OK.',
          // Same shape the backend deep-link routing keys on (see routeForData):
          data: { type: 'approval', screen: 'inbox' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 2,
        },
      })
    } catch (e: any) {
      patch({ error: e?.message ?? 'Could not schedule a test notification.' })
    }
  }, [patch])

  return (
    <Ctx.Provider value={{ status, enable, deregister, sendTest }}>{children}</Ctx.Provider>
  )
}

export function usePush(): PushApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePush must be used within <PushProvider>')
  return v
}

// Map a notification's `data` payload to the tab to open. The backend attaches
// this data when it emits a push; today it sends { agentId, taskId } on task
// completion, and MOB-3's backend leg will add { type:'approval', approvalId }
// on approval-needed. We route defensively on whatever is present.
export function routeForData(data: unknown): PushRouteTarget {
  const d = (data ?? {}) as Record<string, unknown>
  const type = String(d.type ?? d.screen ?? '').toLowerCase()
  if (type.includes('approval') || d.approvalId) return 'inbox'
  if (d.agentId && !d.taskId) return 'agents'
  if (d.taskId || d.agentId) return 'command'
  if (type === 'budget_warning') return 'status'
  return 'command'
}

// Wire notification taps to navigation. Handles BOTH the cold-start case (the app
// was launched by tapping a notification → getLastNotificationResponseAsync) and
// the warm case (a tap while running → the response listener). Call once, high in
// the signed-in tree, passing your tab setter.
export function useNotificationRouting(onRoute: (t: PushRouteTarget) => void): void {
  const onRouteRef = useRef(onRoute)
  onRouteRef.current = onRoute

  useEffect(() => {
    const Notifications = getNotifications()
    // No notifications module → no taps to route. Nothing to wire, nothing to throw.
    if (!Notifications) return

    let cancelled = false
    // Cold start: launched from a notification tap.
    Notifications.getLastNotificationResponseAsync()
      .then((resp) => {
        if (cancelled || !resp) return
        onRouteRef.current(routeForData(resp.notification.request.content.data))
      })
      .catch(() => {})

    // Warm: tapped while the app is running.
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      onRouteRef.current(routeForData(resp.notification.request.content.data))
    })
    return () => {
      cancelled = true
      sub.remove()
    }
  }, [])
}
