import { ClerkProvider, useAuth } from '@clerk/clerk-expo'
import * as SecureStore from 'expo-secure-store'
import { Slot, useRouter, useSegments } from 'expo-router'
import { useEffect, useRef } from 'react'
import { setTokenGetter } from '../lib/api'
import * as Notifications from 'expo-notifications'
import { api } from '../lib/api'

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
})

const tokenCache = {
  async getToken(key: string) { return SecureStore.getItemAsync(key) },
  async saveToken(key: string, value: string) { return SecureStore.setItemAsync(key, value) },
}

function AuthGuard() {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth()
  const segments = useSegments()
  const router = useRouter()
  const notifRegistered = useRef(false)

  useEffect(() => {
    setTokenGetter(() => getToken())
  }, [getToken])

  // Register push notifications
  useEffect(() => {
    if (!isSignedIn || notifRegistered.current) return
    notifRegistered.current = true
    ;(async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync()
        if (status === 'granted') {
          const token = (await Notifications.getExpoPushTokenAsync()).data
          await api.notifications.register(userId!, token)
        }
      } catch (e) { /* non-critical */ }
    })()
  }, [isSignedIn, userId])

  useEffect(() => {
    if (!isLoaded) return
    const inAuth = segments[0] === '(auth)'
    const inOnboarding = segments[0] === 'onboarding'
    if (!isSignedIn && !inAuth) router.replace('/(auth)/sign-in')
    if (isSignedIn && inAuth) router.replace('/(tabs)')
  }, [isLoaded, isSignedIn, segments])

  return <Slot />
}

export default function RootLayout() {
  return (
    <ClerkProvider
      publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!}
      tokenCache={tokenCache}
    >
      <AuthGuard />
    </ClerkProvider>
  )
}
