import { View, Text, StyleSheet } from 'react-native'
import { useTheme, statusColor, statusBg, statusBorder, statusIcon } from '../constants/theme'
import { FontSize, Radius, Space } from '../constants/colors'

// Color-blind safe: every badge shows a dot + icon + label
// Never relies on color alone
export function StatusBadge({ status }: { status: string }) {
  const { theme } = useTheme()
  const color  = statusColor(status, theme)
  const bg     = statusBg(status, theme)
  const border = statusBorder(status, theme)
  const icon   = statusIcon(status)

  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: border }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{icon} {status.replace('_', ' ')}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.sm + 2,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    borderWidth: 0.5,
    gap: 4,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
})
