import { Text, TextStyle } from 'react-native'
import { useTheme } from '../constants/theme'
import { FontSize, FontWeight } from '../constants/colors'

type Variant = 'heading' | 'title' | 'body' | 'secondary' | 'muted' | 'accent' | 'label' | 'mono'

interface Props {
  variant?: Variant
  children: React.ReactNode
  style?: TextStyle
  numberOfLines?: number
}

export function ThemedText({ variant = 'body', children, style, numberOfLines }: Props) {
  const { theme } = useTheme()

  const styles: Record<Variant, TextStyle> = {
    heading: {
      fontSize: FontSize.xxl,
      fontWeight: FontWeight.heavy,
      color: theme.text,
      letterSpacing: -0.4,
    },
    title: {
      fontSize: FontSize.lg,
      fontWeight: FontWeight.semibold,
      color: theme.text,
    },
    body: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.regular,
      color: theme.text,
      lineHeight: 22,
    },
    secondary: {
      fontSize: FontSize.md,
      color: theme.textSecondary,
      lineHeight: 20,
    },
    muted: {
      fontSize: FontSize.sm,
      color: theme.textMuted,
    },
    accent: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: theme.accent,
    },
    label: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: theme.textMuted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    mono: {
      fontSize: FontSize.sm,
      fontFamily: 'monospace',
      color: theme.accent,
    },
  }

  return (
    <Text style={[styles[variant], style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  )
}
