import { useOAuth } from '@clerk/clerk-expo'
import { useRouter } from 'expo-router'
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from 'react-native'
import { Colors, Space, Radius } from '../../constants/colors'

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
      <StatusBar barStyle="light-content" />
      <View style={styles.badge}>
        <Text style={styles.badgeText}>7Ei</Text>
      </View>
      <Text style={styles.title}>Mission Control</Text>
      <Text style={styles.subtitle}>Your modular virtual office</Text>
      <View style={styles.spacer} />
      <Text style={styles.tagline}>Spin up an AI org.{"\n"}Run it from your phone.</Text>
      <View style={styles.spacer} />
      <TouchableOpacity style={styles.button} onPress={handleSignIn} activeOpacity={0.85}>
        <Text style={styles.googleIcon}>G</Text>
        <Text style={styles.buttonText}>Continue with Google</Text>
      </TouchableOpacity>
      <Text style={styles.terms}>By continuing you agree to our Terms of Service</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl, backgroundColor: Colors.bg },
  badge: { width: 72, height: 72, borderRadius: 20, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: Space.lg },
  badgeText: { fontSize: 28, fontWeight: '800', color: '#000' },
  title: { fontSize: 32, fontWeight: '800', color: Colors.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginTop: Space.xs },
  spacer: { height: Space.xxl },
  tagline: { fontSize: 22, fontWeight: '700', color: Colors.text, textAlign: 'center', lineHeight: 32 },
  button: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.text, paddingHorizontal: Space.xl, paddingVertical: Space.md + 2, borderRadius: Radius.md, gap: Space.sm, width: '100%', justifyContent: 'center' },
  googleIcon: { fontSize: 16, fontWeight: '800', color: '#4285F4' },
  buttonText: { fontSize: 16, fontWeight: '600', color: '#000' },
  terms: { fontSize: 12, color: Colors.textMuted, marginTop: Space.lg, textAlign: 'center' },
})
