import { View, Text, StyleSheet } from 'react-native'
import { useTheme, priorityColor } from '../constants/theme'
import { FontSize, Radius, Space } from '../constants/colors'

// Color + icon — color-blind safe
const PRIORITY_ICONS: Record<string, string> = {
  highest: '⬆⬆', high: '⬆', medium: '→', low: '⬇', lowest: '⬇⬇',
}

export function PriorityBadge({ priority }: { priority: string }) {
  const { theme } = useTheme()
  const color = priorityColor(priority, theme)
  const icon  = PRIORITY_ICONS[priority] ?? '→'

  return (
    <View style={[styles.badge, { backgroundColor: color + '14', borderColor: color + '40' }]}>
      <Text style={[styles.label, { color }]}>{icon} {priority}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: Space.sm + 2,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    borderWidth: 0.5,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
})
