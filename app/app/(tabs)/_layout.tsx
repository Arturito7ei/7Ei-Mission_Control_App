import { Tabs } from 'expo-router'
import { Text } from 'react-native'

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: { backgroundColor: '#111111', borderTopColor: '#222222' },
        tabBarActiveTintColor: '#ffffff',
        tabBarInactiveTintColor: '#555555',
        headerStyle: { backgroundColor: '#111111' },
        headerTintColor: '#ffffff',
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: () => <Text>🏠</Text> }} />
      <Tabs.Screen name="agents" options={{ title: 'Agents', tabBarIcon: () => <Text>🤖</Text> }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarIcon: () => <Text>📋</Text> }} />
      <Tabs.Screen name="knowledge" options={{ title: 'Knowledge', tabBarIcon: () => <Text>📚</Text> }} />
      <Tabs.Screen name="costs" options={{ title: 'Costs', tabBarIcon: () => <Text>💰</Text> }} />
    </Tabs>
  )
}
