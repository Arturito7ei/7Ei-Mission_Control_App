import { View, Text, StyleSheet } from 'react-native'
import { Colors } from '../constants/colors'

const STATUS_COLORS: Record<string, string> = {
  idle: Colors.idle, active: Colors.active, paused: Colors.paused, stopped: Colors.error,
  pending: Colors.idle, in_progress: Colors.active, done: Colors.success, blocked: Colors.error, failed: Colors.error,
}

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? Colors.textMuted
  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{status}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, borderWidth: 1, gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
})
