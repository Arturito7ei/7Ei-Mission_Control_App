import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useTheme } from '../constants/theme'
import { Radius, Space, FontSize, FontWeight } from '../constants/colors'

export function EmptyState({ emoji, title, subtitle, actionLabel, onAction }: { emoji: string; title: string; subtitle?: string; actionLabel?: string; onAction?: () => void }) {
  const { theme } = useTheme()
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>{emoji}</Text>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      {subtitle && <Text style={[styles.subtitle, { color: theme.textMuted }]}>{subtitle}</Text>}
      {actionLabel && onAction && (
        <TouchableOpacity style={[styles.action, { backgroundColor: theme.accent }]} onPress={onAction}>
          <Text style={[styles.actionText, { color: theme.white }]}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xxxl, gap: Space.sm },
  emoji: { fontSize: 44 },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.semibold, textAlign: 'center' },
  subtitle: { fontSize: FontSize.md, textAlign: 'center', lineHeight: 20 },
  action: { marginTop: Space.md, paddingHorizontal: Space.xl, paddingVertical: Space.sm, borderRadius: Radius.pill },
  actionText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
})
