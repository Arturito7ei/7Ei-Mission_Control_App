import { View, StyleSheet, ViewStyle } from 'react-native'
import { useTheme } from '../constants/theme'
import { Radius, Space } from '../constants/colors'

type CardVariant = 'default' | 'high' | 'glass' | 'accent' | 'error'

interface CardProps {
  children: React.ReactNode
  style?: ViewStyle
  variant?: CardVariant
  padding?: number
}

export function Card({ children, style, variant = 'default', padding = Space.lg }: CardProps) {
  const { theme } = useTheme()

  const bg = {
    default: theme.surface,
    high:    theme.surfaceHigh,
    glass:   theme.surfaceGlass,
    accent:  theme.accentDim,
    error:   theme.statusErrorBg,
  }[variant]

  const bd = {
    default: theme.border,
    high:    theme.borderLight,
    glass:   theme.borderGlass,
    accent:  theme.accentBorder,
    error:   theme.statusErrorBorder,
  }[variant]

  return (
    <View style={[
      styles.card,
      { backgroundColor: bg, borderColor: bd, padding },
      style,
    ]}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 0.5,
  },
})
