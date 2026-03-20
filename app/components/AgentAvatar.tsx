import { View, Text, StyleSheet } from 'react-native'
import { Colors } from '../constants/colors'

interface Props { emoji: string; size?: number; status?: string }

const STATUS_RING: Record<string, string> = { active: Colors.active, paused: Colors.paused, stopped: Colors.error }

export function AgentAvatar({ emoji, size = 44, status }: Props) {
  const ring = status ? STATUS_RING[status] : undefined
  return (
    <View style={[
      styles.container,
      { width: size, height: size, borderRadius: size / 2 },
      ring && { borderColor: ring, borderWidth: 2 },
    ]}>
      <Text style={{ fontSize: size * 0.45 }}>{emoji}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { backgroundColor: Colors.surfaceHigh, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
})
