import { View, Text, StyleSheet } from 'react-native'
import { useTheme } from '../constants/theme'
import { Card } from './Card'
import { Space, FontSize, FontWeight } from '../constants/colors'

interface Props {
  label: string
  value: string | number
  valueColor?: string
  emoji?: string
}

export function StatCard({ label, value, valueColor, emoji }: Props) {
  const { theme } = useTheme()
  return (
    <Card style={styles.card}>
      {emoji && <Text style={styles.emoji}>{emoji}</Text>}
      <Text style={[styles.value, { color: valueColor ?? theme.text }]}>{value}</Text>
      <Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
    </Card>
  )
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', paddingVertical: Space.md },
  emoji: { fontSize: 16, marginBottom: 4 },
  value: { fontSize: FontSize.xxl, fontWeight: FontWeight.heavy, letterSpacing: -0.5 },
  label: { fontSize: FontSize.xs, marginTop: 3, letterSpacing: 0.3 },
})
