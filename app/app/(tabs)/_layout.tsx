import { Tabs } from 'expo-router'
import { Text, View, Platform } from 'react-native'
import { useTheme } from '../../constants/theme'
import { FontSize, Space } from '../../constants/colors'

function TabIcon({ emoji, focused }: { emoji: string; focused: boolean }) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', opacity: focused ? 1 : 0.38 }}>
      <Text style={{ fontSize: FontSize.lg }}>{emoji}</Text>
    </View>
  )
}

export default function TabLayout() {
  const { theme } = useTheme()

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          borderTopWidth: 0.5,
          height: 64,
          paddingBottom: Platform.OS === 'ios' ? 12 : 8,
          // Glassmorphism-lite: slightly translucent
          ...(Platform.OS !== 'web' ? {} : {
            backdropFilter: 'blur(16px)',
            backgroundColor: theme.surfaceGlass,
          }),
        },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarLabelStyle: {
          fontSize: FontSize.xs,
          fontWeight: '600',
          letterSpacing: 0.2,
          marginTop: 1,
        },
        headerStyle: {
          backgroundColor: theme.surface,
          borderBottomWidth: 0.5,
          borderBottomColor: theme.border,
          shadowOpacity: 0,
          elevation: 0,
        },
        headerTintColor: theme.text,
        headerTitleStyle: {
          fontWeight: '700',
          fontSize: FontSize.lg,
          letterSpacing: -0.2,
        },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen name="index"     options={{ title: 'Home',   tabBarIcon: ({ focused }) => <TabIcon emoji="🏠" focused={focused} /> }} />
      <Tabs.Screen name="agents"    options={{ title: 'Agents', tabBarIcon: ({ focused }) => <TabIcon emoji="🤖" focused={focused} /> }} />
      <Tabs.Screen name="tasks"     options={{ title: 'Tasks',  tabBarIcon: ({ focused }) => <TabIcon emoji="📋" focused={focused} /> }} />
      <Tabs.Screen name="scheduled" options={{ title: 'Scheduled', tabBarIcon: ({ focused }) => <TabIcon emoji="⏰" focused={focused} /> }} />
      <Tabs.Screen name="comms"     options={{ title: 'Comms',  tabBarIcon: ({ focused }) => <TabIcon emoji="📬" focused={focused} /> }} />
      <Tabs.Screen name="costs"     options={{ title: 'Costs',  tabBarIcon: ({ focused }) => <TabIcon emoji="💰" focused={focused} /> }} />
      <Tabs.Screen name="knowledge" options={{ title: 'KB', tabBarIcon: ({ focused }) => <TabIcon emoji="📚" focused={focused} /> }} />
    </Tabs>
  )
}
