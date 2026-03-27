import { View, Text, StyleSheet } from 'react-native'
import { useEffect, useState } from 'react'
import { Colors, Space } from '../constants/colors'

export function OfflineBar() {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let mounted = true
    const check = async () => {
      try {
        const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001'}/health`, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
        if (mounted) setOffline(!res.ok)
      } catch {
        if (mounted) setOffline(true)
      }
    }
    check()
    const interval = setInterval(check, 15000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  if (!offline) return null

  return (
    <View style={styles.bar}>
      <Text style={styles.text}>No internet connection</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { backgroundColor: '#dc2626', paddingVertical: Space.xs, paddingHorizontal: Space.md, alignItems: 'center' },
  text: { color: '#fff', fontSize: 12, fontWeight: '600' },
})
