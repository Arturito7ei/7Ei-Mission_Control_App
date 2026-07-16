// 7Ei Mission Control — iPhone remote (Expo, phase 1).
//
// A thin remote client to the HOSTED backend (7ei-backend.fly.dev): Command
// Center (chat to Arturita), Inbox/Approvals (approve/reject from the phone),
// Agents, and connection status. No navigation library — a hand-rolled bottom tab
// bar keeps the dependency surface tiny so it boots cleanly in Expo Go.

import React, { useState } from 'react'
import { SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { AuthProvider, useAuth } from './src/auth'
import { PushProvider, useNotificationRouting } from './src/notifications'
import { font, space, theme } from './src/theme'
import { Loading } from './src/ui'
import AgentsScreen from './src/screens/AgentsScreen'
import CommandCenterScreen from './src/screens/CommandCenterScreen'
import ConnectScreen from './src/screens/ConnectScreen'
import HealthScreen from './src/screens/HealthScreen'
import InboxScreen from './src/screens/InboxScreen'

type TabKey = 'command' | 'inbox' | 'agents' | 'status'

const TABS: { key: TabKey; label: string; glyph: string; title: string }[] = [
  { key: 'command', label: 'Command', glyph: '✦', title: 'Command Center' },
  { key: 'inbox', label: 'Inbox', glyph: '✓', title: 'Approvals' },
  { key: 'agents', label: 'Agents', glyph: '🤖', title: 'Agents' },
  { key: 'status', label: 'Status', glyph: '◈', title: 'Connection' },
]

function Shell() {
  const { ready, signedIn, orgId } = useAuth()
  const [tab, setTab] = useState<TabKey>('command')

  // Tapping a push deep-links to the relevant tab (approval → Inbox, etc.). Wired
  // whenever mounted; the routing hook itself no-ops when there's no tap to handle.
  useNotificationRouting((target) => setTab(target))

  if (!ready) return <Loading text="Loading…" />
  // Signed in but no org chosen yet → the Connect screen shows the org picker.
  if (!signedIn || !orgId) return <ConnectScreen />

  const active = TABS.find((t) => t.key === tab)!

  return (
    <PushProvider>
      <View style={{ flex: 1 }}>
        <View style={s.header}>
          <Text style={s.headerTitle}>{active.title}</Text>
        </View>
        <View style={{ flex: 1 }}>
          {tab === 'command' && <CommandCenterScreen />}
          {tab === 'inbox' && <InboxScreen />}
          {tab === 'agents' && <AgentsScreen />}
          {tab === 'status' && <HealthScreen />}
        </View>
        <View style={s.tabbar}>
          {TABS.map((t) => {
            const on = t.key === tab
            return (
              <Text
                key={t.key}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setTab(t.key)}
                style={[s.tab, on && s.tabOn]}
              >
                {t.glyph}
                {'\n'}
                <Text style={s.tabLabel}>{t.label}</Text>
              </Text>
            )
          })}
        </View>
      </View>
    </PushProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <SafeAreaView style={s.safe}>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
        <Shell />
      </SafeAreaView>
    </AuthProvider>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.s3,
  },
  headerTitle: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  tabbar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: theme.s3,
    backgroundColor: theme.s1,
    paddingBottom: space.sm,
  },
  tab: {
    flex: 1,
    textAlign: 'center',
    paddingTop: space.md,
    paddingBottom: space.xs,
    color: theme.textFaint,
    fontSize: 20,
  },
  tabOn: { color: theme.blue },
  tabLabel: { fontSize: font.sm - 1, fontWeight: '700' },
})
