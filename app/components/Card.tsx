import { View, StyleSheet, ViewStyle } from 'react-native'
import { Colors, Radius, Space } from '../constants/colors'

interface CardProps { children: React.ReactNode; style?: ViewStyle; variant?: 'default' | 'high' }

export function Card({ children, style, variant = 'default' }: CardProps) {
  return (
    <View style={[
      styles.card,
      variant === 'high' && styles.high,
      style,
    ]}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Space.lg, borderWidth: 1, borderColor: Colors.border },
  high: { backgroundColor: Colors.surfaceHigh },
})
