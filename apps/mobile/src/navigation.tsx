// MOB-6a — the navigation shell.
//
// SHAPE: a bottom tab bar of the four surfaces MOB-1..4 shipped, plus a "More"
// tab listing every other Mission Control section. Tapping a row PUSHES that
// section onto a stack above the tabs, so it gets a back button and the iOS
// swipe-back gesture for free. Nothing is nested more than two deep.
//
//   RootStack
//     ├── Tabs        Command · Inbox · Agents · Status · More
//     └── Section     any destination pushed from More (real screen or placeholder)
//
// WHY the tab bar stays at five: iOS collapses a sixth tab into its own "More"
// with a worse list than ours, and the targets get too small before that. The
// model decides membership (`primary` in navModel.ts), not this file.
//
// WHY react-navigation, when MOB-1 deliberately hand-rolled the bar: the bar was
// the whole navigation. Once sections push, we need a stack — back gestures,
// header wiring, and the Android back button are exactly the things you should
// not hand-roll. All five packages ship inside Expo Go on SDK 54, so the "boots
// in stock Expo Go" constraint is untouched.
//
// The only surface list in the app is navModel.ts. This file adds nothing to it:
// it maps ids to components and lets the model decide the rest.

import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigatorScreenParams,
  type Theme as NavTheme,
} from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import React, { useCallback, useMemo, useRef } from 'react'
import { Text } from 'react-native'
import { findNavItem, primaryItems, type NavItem } from './navModel'
import { useNotificationRouting, type PushRouteTarget } from './notifications'
import { font, theme } from './theme'
import AgentsScreen from './screens/AgentsScreen'
import CommandCenterScreen from './screens/CommandCenterScreen'
import HealthScreen from './screens/HealthScreen'
import InboxScreen from './screens/InboxScreen'
import MoreScreen from './screens/MoreScreen'
import PlaceholderScreen from './screens/PlaceholderScreen'

/**
 * The built screens, keyed by navModel id. THIS is the registry stage 6b+ grows:
 * add the component here, flip `status: 'ready'` in navModel.ts, done. Anything
 * absent falls through to the placeholder — a missing entry is never a crash.
 */
const SCREENS: Record<string, React.ComponentType> = {
  assistant: CommandCenterScreen,
  inbox: InboxScreen,
  agents: AgentsScreen,
  status: HealthScreen,
}

/** Render a destination: its real screen if built, otherwise the placeholder. */
function renderItem(item: NavItem) {
  const Screen = SCREENS[item.id]
  return Screen ? <Screen /> : <PlaceholderScreen item={item} />
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Tab routes are generated from the model, so their names are data, not literals
 * — hence the open `Record<string, undefined>` rather than a hand-kept union that
 * would silently drift from navModel.ts. `Section` is the typed one that matters:
 * it's the only route carrying params.
 */
export type TabParamList = Record<string, undefined>

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined
  Section: { id: string }
}

export const navRef = createNavigationContainerRef<RootStackParamList>()

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator<RootStackParamList>()

/**
 * MOB-3's push routing speaks its own target vocabulary ('command' for the
 * Command Center). The nav model uses the WEB's id for that surface ('assistant')
 * so the two clients agree on what a surface is called. Translate at this seam
 * rather than renaming either side: notifications.tsx is MOB-3's, and the web id
 * is what docs and deep links mean.
 */
const PUSH_TARGET_TO_TAB: Record<PushRouteTarget, string> = {
  command: 'assistant',
  inbox: 'inbox',
  agents: 'agents',
  status: 'status',
}

// react-navigation paints the surfaces behind our screens (card background, the
// header, the gap under a bounce). Hand it our palette so nothing flashes white.
const navTheme: NavTheme = {
  dark: true,
  colors: {
    primary: theme.blue,
    background: theme.bg,
    card: theme.bg,
    text: theme.text,
    border: theme.s3,
    notification: theme.orange,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '600' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '800' },
  },
}

const headerOptions = {
  headerStyle: { backgroundColor: theme.bg },
  headerTintColor: theme.text,
  headerTitleStyle: { color: theme.text, fontWeight: '800' as const, fontSize: font.xl },
  headerShadowVisible: false,
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function TabsNavigator({ onOpenSection }: { onOpenSection: (id: string) => void }) {
  // Stable component identities: a new function on every render would remount the
  // screen (and drop its state) each time the parent re-renders.
  const more = useCallback(() => <MoreScreen onOpen={onOpenSection} />, [onOpenSection])
  const tabs = useMemo(() => primaryItems(), [])

  return (
    <Tab.Navigator
      screenOptions={{
        ...headerOptions,
        tabBarActiveTintColor: theme.blue,
        tabBarInactiveTintColor: theme.textFaint,
        tabBarStyle: { backgroundColor: theme.s1, borderTopColor: theme.s3 },
        // Labels always on. The glyph is decoration; the word is the meaning —
        // an icon-only bar would put us back to meaning-by-shape-and-hue.
        tabBarLabelStyle: { fontSize: font.sm - 1, fontWeight: '700' },
      }}
    >
      {tabs.map((item) => (
        <Tab.Screen
          key={item.id}
          name={item.id}
          options={{
            // Short bar label, full title in the header — "Command" fits the tab,
            // "Command Center" is what the screen is.
            tabBarLabel: tabLabel(item),
            title: item.label,
            tabBarIcon: ({ color }) => <TabGlyph glyph={item.glyph} color={color} />,
          }}
        >
          {() => renderItem(item)}
        </Tab.Screen>
      ))}
      <Tab.Screen
        name="more"
        component={more}
        options={{
          title: 'More',
          tabBarLabel: 'More',
          tabBarIcon: ({ color }) => <TabGlyph glyph="☰" color={color} />,
        }}
      />
    </Tab.Navigator>
  )
}

/** The tab bar is tight — keep the two long ones short, leave the rest alone. */
function tabLabel(item: NavItem): string {
  if (item.id === 'assistant') return 'Command'
  return item.label
}

function TabGlyph({ glyph, color }: { glyph: string; color: string }) {
  return (
    // The label carries the meaning; the glyph would just repeat it to a screen
    // reader, so hide it from the a11y tree.
    <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 18, color }}>
      {glyph}
    </Text>
  )
}

// ─── Pushed sections ─────────────────────────────────────────────────────────

function SectionScreen({ route }: { route: { params: { id: string } } }) {
  const item = findNavItem(route.params.id)
  // An unknown id can only come from a bad push payload or a stale deep link.
  // Say so plainly instead of rendering a blank screen.
  if (!item) return <PlaceholderScreen item={UNKNOWN} />
  return renderItem(item)
}

const UNKNOWN: NavItem = {
  id: 'unknown',
  label: 'Unknown section',
  glyph: '⚠',
  status: 'gap',
  blurb: "This section isn't in the navigation model — the link that sent you here is stale.",
}

// ─── Root ────────────────────────────────────────────────────────────────────

export default function RootNavigator() {
  const openSection = useCallback((id: string) => {
    if (navRef.isReady()) navRef.navigate('Section', { id })
  }, [])

  // A cold start FROM a notification tap resolves before the container mounts, so
  // routing straight at navRef would silently drop exactly the deep link that
  // matters most. Hold the target and flush it in onReady.
  const pending = useRef<string | null>(null)

  const goToTab = useCallback((tab: string) => {
    // Navigating to the Tabs route pops any pushed section on the way, so a tap
    // arriving while a section is open lands ON the tab rather than leaving it
    // buried under a stale back stack.
    if (navRef.isReady()) navRef.navigate('Tabs', { screen: tab })
    else pending.current = tab
  }, [])

  // MOB-3 deep links: a notification tap lands on its tab. Push targets are all
  // primary tabs today, so this is always a tab jump, never a section push.
  useNotificationRouting((target) => goToTab(PUSH_TARGET_TO_TAB[target]))

  const onReady = useCallback(() => {
    const tab = pending.current
    pending.current = null
    if (tab) navRef.navigate('Tabs', { screen: tab })
  }, [])

  return (
    <NavigationContainer ref={navRef} theme={navTheme} onReady={onReady}>
      <Stack.Navigator screenOptions={headerOptions}>
        <Stack.Screen name="Tabs" options={{ headerShown: false }}>
          {() => <TabsNavigator onOpenSection={openSection} />}
        </Stack.Screen>
        <Stack.Screen
          name="Section"
          component={SectionScreen as React.ComponentType}
          options={({ route }) => ({
            title: findNavItem((route.params as { id: string }).id)?.label ?? 'Section',
          })}
        />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
