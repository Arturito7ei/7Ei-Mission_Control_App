import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle } from 'react-native'
import { useTheme } from '../constants/theme'
import { Radius, Space, FontSize, FontWeight } from '../constants/colors'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass'

interface Props {
  label: string
  onPress: () => void
  variant?: Variant
  loading?: boolean
  disabled?: boolean
  style?: ViewStyle
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ label, onPress, variant = 'primary', loading, disabled, style, size = 'md' }: Props) {
  const { theme, mode } = useTheme()

  const pad = { sm: Space.sm, md: Space.md, lg: Space.lg }[size]
  const hPad = { sm: Space.md, md: Space.xl, lg: Space.xl + 4 }[size]
  const fs = { sm: FontSize.sm, md: FontSize.base, lg: FontSize.lg }[size]

  const bg = {
    primary:   theme.accent,
    secondary: 'transparent',
    ghost:     'transparent',
    danger:    theme.statusErrorBg,
    glass:     theme.surfaceGlass,
  }[variant]

  const tc = {
    primary:   mode === 'dark' ? '#ffffff' : '#ffffff',
    secondary: theme.textSecondary,
    ghost:     theme.accent,
    danger:    theme.statusError,
    glass:     theme.text,
  }[variant]

  const bc = {
    primary:   'transparent',
    secondary: theme.borderLight,
    ghost:     'transparent',
    danger:    theme.statusErrorBorder,
    glass:     theme.borderGlass,
  }[variant]

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.75}
      style={[
        styles.btn,
        {
          backgroundColor: bg,
          borderColor: bc,
          paddingVertical: pad,
          paddingHorizontal: hPad,
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
    >
      {loading
        ? <ActivityIndicator size="small" color={tc} />
        : <Text style={[styles.label, { color: tc, fontSize: fs }]}>{label}</Text>
      }
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  btn: {
    borderRadius: Radius.md,
    borderWidth: 0.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.1,
  },
})
