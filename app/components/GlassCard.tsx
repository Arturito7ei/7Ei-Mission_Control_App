import { View, StyleSheet, ViewStyle, Platform } from 'react-native'
import { useTheme } from '../constants/theme'
import { Radius, Space } from '../constants/colors'

// GlassCard — Notion-inspired glassmorphism
// Uses backdrop-filter on web, semi-transparent bg on native
interface Props {
  children: React.ReactNode
  style?: ViewStyle
  intensity?: 'low' | 'medium' | 'high'
}

export function GlassCard({ children, style, intensity = 'medium' }: Props) {
  const { theme } = useTheme()

  // On native, approximated with semi-transparent bg
  const alpha = { low: '0.55', medium: '0.72', high: '0.88' }[intensity]
  const blurAmount = { low: 8, medium: 16, high: 24 }[intensity]

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.surfaceGlass,
          borderColor: theme.borderGlass,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 0.5,
    padding: Space.lg,
    // On web this will work with backdrop-filter via style prop extension
  },
})
