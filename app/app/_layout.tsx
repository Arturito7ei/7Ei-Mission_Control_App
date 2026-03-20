import { ClerkProvider, useAuth } from '@clerk/clerk-expo'
import * as SecureStore from 'expo-secure-store'
import { Slot, useRouter, useSegments } from 'expo-router'
import { useEffect } from 'react'
import { setTokenGetter } from '../lib/api'

const tokenCache = {
  async getToken(key: string) { return SecureStore.getItemAsync(key) },
  async saveToken(key: string, value: string) { return SecureStore.setItemAsync(key, value) },
}

function AuthGuard() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    setTokenGetter(() => getToken())
  }, [getToken])

  useEffect(() => {
    if (!isLoaded) return
    const inAuth = segments[0] === '(auth)'
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
