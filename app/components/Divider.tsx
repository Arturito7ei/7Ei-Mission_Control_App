import { View } from 'react-native'
import { useTheme } from '../constants/theme'

export function Divider({ spacing = 16 }: { spacing?: number }) {
  const { theme } = useTheme()
  return (
    <View style={{ height: 0.5, backgroundColor: theme.border, marginVertical: spacing }} />
  )
}
