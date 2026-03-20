import { Tabs } from 'expo-router'
import { Text, View } from 'react-native'
import { Colors } from '../../constants/colors'

function TabIcon({ emoji, focused }: { emoji: string; focused: boolean }) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', opacity: focused ? 1 : 0.45 }}>
      <Text style={{ fontSize: 20 }}>{emoji}</Text>
    </View>
  )
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: { backgroundColor: Colors.surface, borderTopColor: Colors.border, height: 60, paddingBottom: 8 },
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
        headerStyle: { backgroundColor: Colors.surface },
        headerTintColor: Colors.text,
        headerTitleStyle: { fontWeight: '700', fontSize: 18 },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ focused }) => <TabIcon emoji="🏠" focused={focused} /> }} />
      <Tabs.Screen name="agents" options={{ title: 'Agents', tabBarIcon: ({ focused }) => <TabIcon emoji="🤖" focused={focused} /> }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarIcon: ({ focused }) => <TabIcon emoji="📋" focused={focused} /> }} />
      <Tabs.Screen name="knowledge" options={{ title: 'Knowledge', tabBarIcon: ({ focused }) => <TabIcon emoji="📚" focused={focused} /> }} />
      <Tabs.Screen name="costs" options={{ title: 'Costs', tabBarIcon: ({ focused }) => <TabIcon emoji="💰" focused={focused} /> }} />
    </Tabs>
  )
}
