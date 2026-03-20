import { View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions } from 'react-native'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { Colors, Space, Radius } from '../../constants/colors'

const { width } = Dimensions.get('window')

const STEPS = [
  { emoji: '🏢', title: 'Create your org', subtitle: 'Your virtual office starts with an organisation. Give it a name and you’re set.' },
  { emoji: '🎯', title: 'Meet Arturito', subtitle: 'Your Chief of Staff. Arturito routes tasks, keeps things running, and answers questions.' },
  { emoji: '🤖', title: 'Build your team', subtitle: 'Add department heads — Dev, Marketing, Finance, Ops, R&D. Each is a Claude-powered agent with a specialty.' },
  { emoji: '🎖️', title: 'Silver Board', subtitle: 'Add advisor personas — embody Steve Jobs for product thinking, Marcus Aurelius for philosophy, or any figure you want to consult.' },
  { emoji: '⚡', title: 'Skills', subtitle: 'Assign skills from the shared library to give agents specialised capabilities — from code review to email drafting.' },
  { emoji: '🚀', title: 'Ready', subtitle: 'You’re set. Create your org, spin up Arturito, and send your first message.' },
]

export default function OnboardingScreen() {
  const router = useRouter()
  const { currentOrg } = useStore()
  const [step, setStep] = useState(0)
  const fadeAnim = useRef(new Animated.Value(1)).current

  const goNext = () => {
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start()
    setTimeout(() => {
      if (step < STEPS.length - 1) {
        setStep(s => s + 1)
      } else {
        router.replace(currentOrg ? '/(tabs)' : '/org/create')
      }
    }, 150)
  }

  const skip = () => router.replace(currentOrg ? '/(tabs)' : '/org/create')

  const current = STEPS[step]

  return (
    <View style={styles.container}>
      {/* Progress dots */}
      <View style={styles.dots}>
        {STEPS.map((_, i) => (
          <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
        ))}
      </View>

      <Animated.View style={[styles.card, { opacity: fadeAnim }]}>
        <Text style={styles.emoji}>{current.emoji}</Text>
        <Text style={styles.title}>{current.title}</Text>
        <Text style={styles.subtitle}>{current.subtitle}</Text>
      </Animated.View>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.nextBtn} onPress={goNext}>
          <Text style={styles.nextBtnText}>{step < STEPS.length - 1 ? 'Next →' : 'Get Started'}</Text>
        </TouchableOpacity>
        {step < STEPS.length - 1 && (
          <TouchableOpacity style={styles.skipBtn} onPress={skip}>
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'space-between', padding: Space.xl, paddingTop: 80 },
  dots: { flexDirection: 'row', gap: Space.xs },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.border },
  dotActive: { width: 20, backgroundColor: Colors.accent },
  card: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.xl, paddingHorizontal: Space.lg },
  emoji: { fontSize: 80 },
  title: { fontSize: 30, fontWeight: '800', color: Colors.text, textAlign: 'center', letterSpacing: -0.5 },
  subtitle: { fontSize: 17, color: Colors.textSecondary, textAlign: 'center', lineHeight: 26 },
  actions: { width: '100%', gap: Space.md, paddingBottom: Space.xl },
  nextBtn: { backgroundColor: Colors.accent, padding: Space.lg, borderRadius: Radius.md, alignItems: 'center' },
  nextBtnText: { fontSize: 17, fontWeight: '700', color: '#000' },
  skipBtn: { padding: Space.md, alignItems: 'center' },
  skipText: { fontSize: 15, color: Colors.textMuted },
})
