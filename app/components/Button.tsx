import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle } from 'react-native'
import { Colors, Radius, Space } from '../constants/colors'

interface Props { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean; disabled?: boolean; style?: ViewStyle }

export function Button({ label, onPress, variant = 'primary', loading, disabled, style }: Props) {
  const bg = variant === 'primary' ? Colors.accent : variant === 'danger' ? Colors.error : Colors.surfaceHigh
  const textColor = variant === 'primary' ? '#000' : Colors.text
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      style={[styles.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }, style]}
      activeOpacity={0.7}
    >
      {loading ? <ActivityIndicator size="small" color={textColor} /> : <Text style={[styles.label, { color: textColor }]}>{label}</Text>}
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: Space.xl, paddingVertical: Space.md, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 15, fontWeight: '600' },
})
