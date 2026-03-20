import { useOAuth } from '@clerk/clerk-expo'
import { useRouter } from 'expo-router'
import { View, Text, TouchableOpacity, StyleSheet, StatusBar, Image } from 'react-native'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'

export default function SignIn() {
  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' })
  const router = useRouter()
  const { theme, mode } = useTheme()

  const handleSignIn = async () => {
    try {
      const { createdSessionId, setActive } = await startOAuthFlow()
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId })
        router.replace('/(tabs)')
      }
    } catch (err) { console.error('OAuth error:', err) }
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />

      {/* Logo — 7 hexagons */}
      <View style={[styles.logoWrap, { borderColor: theme.accentBorder }]}>
        <Text style={[styles.logoText, { color: theme.accent }]}>7Ei</Text>
      </View>

      <Text style={[styles.title, { color: theme.text }]}>Mission Control</Text>
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>Your modular virtual office</Text>

      <View style={styles.spacer} />

      {/* Tagline */}
      <View style={[styles.taglineBox, { backgroundColor: theme.accentDim, borderColor: theme.accentBorder }]}>
        <Text style={[styles.tagline, { color: theme.text }]}>
          Spin up an AI org.{"\n"}Run it from your phone.
        </Text>
      </View>

      <View style={styles.spacer} />

      {/* Google sign-in */}
      <TouchableOpacity
        style={[styles.googleBtn, { backgroundColor: theme.text }]}
        onPress={handleSignIn}
        activeOpacity={0.85}
      >
        <Text style={styles.googleG}>G</Text>
        <Text style={[styles.googleLabel, { color: theme.bg }]}>Continue with Google</Text>
      </TouchableOpacity>

      <Text style={[styles.terms, { color: theme.textMuted }]}>
        By continuing you agree to our Terms of Service
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl },
  logoWrap: {
    width: 72, height: 72, borderRadius: 18,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Space.lg,
  },
  logoText: { fontSize: 26, fontWeight: FontWeight.heavy, letterSpacing: -1 },
  title: { fontSize: FontSize.huge, fontWeight: FontWeight.heavy, letterSpacing: -0.8, marginBottom: 6 },
  subtitle: { fontSize: FontSize.lg, marginBottom: 0 },
  spacer: { height: Space.xxxl },
  taglineBox: {
    borderRadius: Radius.lg, borderWidth: 0.5,
    padding: Space.lg, width: '100%', alignItems: 'center',
  },
  tagline: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'center', lineHeight: 30 },
  googleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Space.sm,
    paddingHorizontal: Space.xl, paddingVertical: Space.md + 2,
    borderRadius: Radius.md, width: '100%', justifyContent: 'center',
  },
  googleG: { fontSize: FontSize.lg, fontWeight: FontWeight.heavy, color: '#4285F4' },
  googleLabel: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  terms: { fontSize: FontSize.xs, marginTop: Space.lg, textAlign: 'center' },
})
