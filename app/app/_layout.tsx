import { ClerkProvider, useAuth } from '@clerk/clerk-expo'
import * as SecureStore from 'expo-secure-store'
import { Slot, useRouter, useSegments } from 'expo-router'
import { useEffect, useRef } from 'react'
import { StatusBar } from 'expo-status-bar'
import { setTokenGetter } from '../lib/api'
import { api } from '../lib/api'
import { useColorScheme } from 'react-native'
import * as Notifications from 'expo-notifications'
import { OfflineBar } from '../components/OfflineBar'

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
  const scheme = useColorScheme()
  const notifRegistered = useRef(false)

  useEffect(() => {
    setTokenGetter(() => getToken())
  }, [getToken])

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
      } catch {}
    })()
  }, [isSignedIn, userId])

  // Handle notification tap → navigate to relevant screen
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data
      if (data?.agentId) router.push(`/agents/${data.agentId}`)
      else if (data?.taskId) router.push(`/tasks/${data.taskId}`)
    })
    return () => sub.remove()
  }, [router])

  useEffect(() => {
    if (!isLoaded) return
    const inAuth = segments[0] === '(auth)'
    if (!isSignedIn && !inAuth) router.replace('/(auth)/sign-in')
    if (isSignedIn && inAuth) router.replace('/(tabs)')
  }, [isLoaded, isSignedIn, segments])

  return (
    <>
      <OfflineBar />
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <Slot />
    </>
  )
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
