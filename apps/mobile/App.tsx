// 7Ei Mission Control — iPhone remote (Expo, phase 1).
//
// A thin remote client to the HOSTED backend (7ei-backend.fly.dev). App.tsx is
// now just the shell: auth gate → push provider → navigator. The navigation
// itself lives in src/navigation.tsx, driven by src/navModel.ts (MOB-6a).
//
// MOB-6a replaced the hand-rolled 4-tab bar with react-navigation. The four tabs
// it drew are unchanged — they're the `primary` entries in navModel.ts — but the
// bar can no longer be the whole of navigation once ~25 more sections exist, and
// a pushed stack (back gesture, header, Android back button) is not something to
// hand-roll. Every package it needs ships inside Expo Go on SDK 54, so the
// "opens in stock App Store Expo Go" constraint still holds.

import React from 'react'
import { StatusBar } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from './src/auth'
import { PushProvider } from './src/notifications'
import RootNavigator from './src/navigation'
import { theme } from './src/theme'
import { Loading } from './src/ui'
import ConnectScreen from './src/screens/ConnectScreen'

function Shell() {
  const { ready, signedIn, orgId } = useAuth()

  if (!ready)
    return (
      <Gate>
        <Loading text="Loading…" />
      </Gate>
    )
  // Signed in but no org chosen yet → the Connect screen shows the org picker.
  if (!signedIn || !orgId)
    return (
      <Gate>
        <ConnectScreen />
      </Gate>
    )

  return (
    <PushProvider>
      <RootNavigator />
    </PushProvider>
  )
}

/**
 * The pre-navigation screens (Loading, Connect) render outside the navigator, so
 * they get none of its automatic insets — and neither draws its own. This is the
 * safe area the old top-level SafeAreaView used to give them; without it, Connect
 * renders under the notch.
 */
function Gate({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>{children}</SafeAreaView>
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
        <Shell />
      </AuthProvider>
    </SafeAreaProvider>
  )
}
