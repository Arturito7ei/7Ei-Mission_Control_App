import { useOAuth } from '@clerk/clerk-expo'
import { useRouter } from 'expo-router'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'

export default function SignIn() {
  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' })
  const router = useRouter()

  const handleSignIn = async () => {
    try {
      const { createdSessionId, setActive } = await startOAuthFlow()
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId })
        router.replace('/(tabs)')
      }
    } catch (err) {
      console.error('OAuth error:', err)
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>7Ei Mission Control</Text>
      <Text style={styles.subtitle}>Your modular virtual office</Text>
      <TouchableOpacity style={styles.button} onPress={handleSignIn}>
        <Text style={styles.buttonText}>Continue with Google</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#0a0a0a' },
  title: { fontSize: 28, fontWeight: '700', color: '#ffffff', marginBottom: 8 },
  subtitle: { fontSize: 16, color: '#888888', marginBottom: 48 },
  button: { backgroundColor: '#ffffff', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 8 },
  buttonText: { fontSize: 16, fontWeight: '600', color: '#0a0a0a' },
})
