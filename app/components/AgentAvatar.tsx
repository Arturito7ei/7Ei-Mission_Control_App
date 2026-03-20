import { View, Text, StyleSheet } from 'react-native'
import { useTheme } from '../constants/theme'
import { Dark } from '../constants/colors'

interface Props { emoji: string; size?: number; status?: string }

export function AgentAvatar({ emoji, size = 44, status }: Props) {
  const { theme } = useTheme()

  // Ring color: active = purple, paused = yellow, stopped = red (with icon elsewhere)
  const ringColor = (() => {
    if (!status || status === 'idle') return undefined
    if (status === 'active' || status === 'in_progress') return theme.statusActive
    if (status === 'paused') return theme.statusWarning
    if (status === 'stopped' || status === 'failed') return theme.statusError
    return undefined
  })()

  const ringWidth = ringColor ? 1.5 : 0.5
  const ringC = ringColor ?? theme.borderLight

  return (
    <View style={[
      styles.outer,
      {
        width: size + (ringColor ? 4 : 0),
        height: size + (ringColor ? 4 : 0),
        borderRadius: (size + (ringColor ? 4 : 0)) / 2,
        borderColor: ringC,
        borderWidth: ringWidth,
        backgroundColor: ringColor ? ringColor + '18' : 'transparent',
        padding: ringColor ? 2 : 0,
      },
    ]}>
      <View style={[
        styles.inner,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.surfaceHigh,
          borderColor: theme.border,
        },
      ]}>
        <Text style={{ fontSize: size * 0.48 }}>{emoji}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  outer: { alignItems: 'center', justifyContent: 'center' },
  inner: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5 },
})
