import { useEffect, useRef } from 'react'
import { View, Animated, StyleSheet, ViewStyle } from 'react-native'
import { useTheme } from '../constants/theme'
import { Radius } from '../constants/colors'

interface Props { width?: number | string; height?: number; style?: ViewStyle; radius?: number }

export function Skeleton({ width = '100%', height = 16, style, radius = Radius.sm }: Props) {
  const { theme } = useTheme()
  const opacity = useRef(new Animated.Value(0.3)).current

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
      ])
    )
    anim.start()
    return () => anim.stop()
  }, [])

  return (
    <Animated.View
      style={[
        { width: width as any, height, borderRadius: radius, backgroundColor: theme.surfaceHigh, opacity },
        style,
      ]}
    />
  )
}

export function AgentCardSkeleton() {
  return (
    <View style={skStyles.card}>
      <Skeleton width={44} height={44} radius={22} />
      <View style={skStyles.info}>
        <Skeleton width="60%" height={14} style={{ marginBottom: 6 }} />
        <Skeleton width="80%" height={11} />
      </View>
      <Skeleton width={60} height={22} radius={11} />
    </View>
  )
}

export function TaskCardSkeleton() {
  return (
    <View style={skStyles.card}>
      <View style={{ flex: 1 }}>
        <Skeleton width="85%" height={14} style={{ marginBottom: 6 }} />
        <Skeleton width="40%" height={11} />
      </View>
      <Skeleton width={56} height={22} radius={11} />
    </View>
  )
}

const skStyles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  info: { flex: 1 },
})
