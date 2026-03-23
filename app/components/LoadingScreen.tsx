import { View, ActivityIndicator, StyleSheet } from 'react-native'
import { useTheme } from '../constants/theme'

export function LoadingScreen() {
  const { theme } = useTheme()
  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <ActivityIndicator size="large" color={theme.accent} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
