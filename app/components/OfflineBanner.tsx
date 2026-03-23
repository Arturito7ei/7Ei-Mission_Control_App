import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { Dark, Space, FontSize, FontWeight } from '../constants/colors'

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false)

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setIsOffline(!state.isConnected)
    })
    return unsub
  }, [])

  if (!isOffline) return null

  return (
    <View style={styles.banner}>
      <Text style={styles.icon}>⚡</Text>
      <Text style={styles.text}>No internet connection — some features unavailable</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: Dark.statusWarning,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
  icon: { fontSize: 14 },
  text: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.medium, color: '#000' },
})
