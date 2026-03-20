import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { useTheme } from '../constants/theme'
import { Space, FontSize, FontWeight } from '../constants/colors'

interface Props {
  title: string
  action?: string
  onAction?: () => void
}

export function SectionHeader({ title, action, onAction }: Props) {
  const { theme } = useTheme()
  return (
    <View style={styles.row}>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      {action && onAction && (
        <TouchableOpacity onPress={onAction}>
          <Text style={[styles.action, { color: theme.accent }]}>{action} →</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Space.sm },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  action: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
})
