import { View, Text, StyleSheet } from 'react-native'
import { useTheme } from '../constants/theme'
import { Space, FontSize, FontWeight } from '../constants/colors'

export function EmptyState({ emoji, title, subtitle }: { emoji: string; title: string; subtitle?: string }) {
  const { theme } = useTheme()
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>{emoji}</Text>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      {subtitle && <Text style={[styles.subtitle, { color: theme.textMuted }]}>{subtitle}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xxxl, gap: Space.sm },
  emoji: { fontSize: 44 },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.semibold, textAlign: 'center' },
  subtitle: { fontSize: FontSize.md, textAlign: 'center', lineHeight: 20 },
})
