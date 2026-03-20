import { View, Text, StyleSheet } from 'react-native'
import { Colors } from '../constants/colors'

const PRIORITY_COLORS: Record<string, string> = {
  highest: Colors.highest, high: Colors.high, medium: Colors.medium, low: Colors.low, lowest: Colors.lowest,
}

export function PriorityBadge({ priority }: { priority: string }) {
  const color = PRIORITY_COLORS[priority] ?? Colors.textMuted
  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <Text style={[styles.label, { color }]}>{priority}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, borderWidth: 1 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
})
