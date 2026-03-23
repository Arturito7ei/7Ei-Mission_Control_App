import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import type { OnboardingConfig } from '../../store'
import { Colors, Space, Radius, FontSize, FontWeight } from '../../constants/colors'

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldDef = {
  key: keyof OnboardingConfig
  label: string
  placeholder: string
  multiline?: boolean
  required?: boolean
}

type OptionDef = {
  key: string
  emoji: string
  label: string
  subtitle?: string
}

type InfoStep = {
  id: string
  type: 'info'
  arturitoSays: string
  emoji: string
  title: string
  condition?: (c: OnboardingConfig) => boolean
}

type InputStep = {
  id: string
  type: 'input'
  arturitoSays: string
  fields: FieldDef[]
  condition?: (c: OnboardingConfig) => boolean
}

type ChoiceStep = {
  id: string
  type: 'choice'
  arturitoSays: string
  options: OptionDef[]
  storeKey: keyof OnboardingConfig
  condition?: (c: OnboardingConfig) => boolean
}

type Step = InfoStep | InputStep | ChoiceStep

// ─── Step definitions ─────────────────────────────────────────────────────────

const ALL_STEPS: Step[] = [
  {
    id: 'welcome',
    type: 'info',
    emoji: '🤖',
    title: 'Your Chief of Staff',
    arturitoSays:
      "Hello! I'm Arturito — your Chief of Staff and Agent Orchestrator. I'll set up your Mission Control and build your entire virtual organisation from scratch. Ready to begin?",
  },
  {
    id: 'org-name',
    type: 'input',
    arturitoSays: "What's the name of your company, project, or enterprise organisation?",
    fields: [
      {
        key: 'orgName',
        label: 'Organisation Name',
        placeholder: 'e.g. 7Ei, Acme Corp, My Startup',
        required: true,
      },
      {
        key: 'orgDescription',
        label: 'What does it do? (optional)',
        placeholder: 'A brief description…',
        multiline: true,
      },
    ],
  },
  {
    id: 'common-knowledge',
    type: 'input',
    arturitoSays:
      "I need your organisation's context. This becomes the shared knowledge base — every agent I create will be briefed with it. Think of it as my onboarding handbook.",
    fields: [
      {
        key: 'mission',
        label: 'Mission & Vision',
        placeholder: 'Why does this organisation exist? Where is it going?',
        multiline: true,
      },
      {
        key: 'culture',
        label: 'Culture & Operating Principles',
        placeholder: 'How do you work? What values guide decisions?',
        multiline: true,
      },
    ],
  },
  {
    id: 'deploy-mode',
    type: 'choice',
    arturitoSays:
      'I need a place to operate from. Where should I and your future agents be hosted?',
    storeKey: 'deployMode',
    options: [
      {
        key: 'cloud',
        emoji: '☁️',
        label: 'Cloud',
        subtitle: 'AWS, GCP, Azure or Oracle — I configure it for you',
      },
      {
        key: 'local',
        emoji: '💻',
        label: 'Local / On-Premise',
        subtitle: 'Your own hardware, server, or private infrastructure',
      },
    ],
  },
  {
    id: 'cloud-provider',
    type: 'choice',
    condition: (c) => c.deployMode === 'cloud',
    arturitoSays: 'Which cloud service should I call home?',
    storeKey: 'cloudProvider',
    options: [
      {
        key: 'aws',
        emoji: '🟠',
        label: 'AWS Bedrock',
        subtitle: 'Amazon — recommended for most organisations',
      },
      {
        key: 'gcp',
        emoji: '🔵',
        label: 'Google Cloud',
        subtitle: 'Vertex AI & Gemini ecosystem',
      },
      {
        key: 'azure',
        emoji: '🟦',
        label: 'Microsoft Azure',
        subtitle: 'Azure OpenAI services',
      },
      {
        key: 'oracle',
        emoji: '🔴',
        label: 'Oracle Cloud',
        subtitle: 'OCI compute infrastructure',
      },
    ],
  },
  {
    id: 'llm',
    type: 'choice',
    condition: (c) => c.deployMode === 'cloud',
    arturitoSays:
      'Which AI model should power me and your agents? You can change this anytime in Settings.',
    storeKey: 'preferredLlm',
    options: [
      {
        key: 'claude',
        emoji: '🧠',
        label: 'Claude  ·  Recommended',
        subtitle: 'Anthropic — best for complex reasoning & long context',
      },
      {
        key: 'gpt4o',
        emoji: '💬',
        label: 'GPT-4o',
        subtitle: 'OpenAI — strong all-rounder',
      },
      {
        key: 'gemini',
        emoji: '✨',
        label: 'Gemini',
        subtitle: 'Google — great for multimodal & search',
      },
    ],
  },
  {
    id: 'first-agent',
    type: 'choice',
    arturitoSays:
      "Let's spin up your first specialist agent. Which department does your organisation need most right now?",
    storeKey: 'firstAgentRole',
    options: [
      {
        key: 'marketing',
        emoji: '📣',
        label: 'Marketing',
        subtitle: 'Content, campaigns & brand voice',
      },
      {
        key: 'engineering',
        emoji: '⚙️',
        label: 'Engineering',
        subtitle: 'Code, architecture & dev ops',
      },
      {
        key: 'finance',
        emoji: '💰',
        label: 'Finance',
        subtitle: 'Budgets, forecasts & reporting',
      },
      {
        key: 'operations',
        emoji: '🔧',
        label: 'Operations',
        subtitle: 'Processes, logistics & coordination',
      },
    ],
  },
  {
    id: 'ready',
    type: 'info',
    emoji: '🚀',
    title: 'Mission Control Active',
    arturitoSays:
      "Everything is in place. I've briefed myself on your organisation and I'm ready to coordinate your team. Let's get to work.",
  },
]

const INITIAL_CONFIG: OnboardingConfig = {
  orgName: '',
  orgDescription: '',
  mission: '',
  culture: '',
  deployMode: null,
  cloudProvider: null,
  preferredLlm: null,
  firstAgentRole: null,
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter()
  const { currentOrg, setOnboardingConfig } = useStore()

  const [config, setConfig] = useState<OnboardingConfig>(INITIAL_CONFIG)
  const [stepIdx, setStepIdx] = useState(0)
  const fadeAnim = useRef(new Animated.Value(1)).current

  // Recompute visible steps whenever config changes
  const visibleSteps = ALL_STEPS.filter((s) => !s.condition || s.condition(config))
  const step = visibleSteps[Math.min(stepIdx, visibleSteps.length - 1)]
  const isLast = stepIdx >= visibleSteps.length - 1
  const progress = (stepIdx + 1) / visibleSteps.length

  const animateNext = (fn: () => void) => {
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 130, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start()
    setTimeout(fn, 130)
  }

  const canContinue = (): boolean => {
    if (step.type === 'input') {
      return (step as InputStep).fields
        .filter((f) => f.required)
        .every((f) => !!(config[f.key] as string).trim())
    }
    return true
  }

  const finish = (finalConfig: OnboardingConfig) => {
    setOnboardingConfig(finalConfig)
    router.replace(currentOrg ? '/(tabs)' : '/org/create')
  }

  const handleContinue = () => {
    if (!canContinue()) return
    if (isLast) { finish(config); return }
    animateNext(() => setStepIdx((i) => i + 1))
  }

  // Choice steps auto-advance on tap
  const handleChoice = (optKey: string) => {
    if (step.type !== 'choice') return
    const cs = step as ChoiceStep
    const updated: OnboardingConfig = { ...config, [cs.storeKey]: optKey as any }
    const nextVisible = ALL_STEPS.filter((s) => !s.condition || s.condition(updated))
    const nextIdx = stepIdx + 1
    if (nextIdx >= nextVisible.length) { finish(updated); return }
    setConfig(updated)
    animateNext(() => setStepIdx(nextIdx))
  }

  const updateField = (key: keyof OnboardingConfig, value: string) =>
    setConfig((c) => ({ ...c, [key]: value }))

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` as any }]} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Arturito header + speech bubble */}
        <View style={styles.arturitoRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarEmoji}>🤖</Text>
          </View>
          <View style={styles.bubble}>
            <Text style={styles.bubbleLabel}>ARTURITO</Text>
            <Text style={styles.bubbleText}>{step.arturitoSays}</Text>
          </View>
        </View>

        {/* Step content */}
        <Animated.View style={{ opacity: fadeAnim }}>

          {step.type === 'info' && (
            <View style={styles.infoCard}>
              <Text style={styles.infoEmoji}>{(step as InfoStep).emoji}</Text>
              <Text style={styles.infoTitle}>{(step as InfoStep).title}</Text>
            </View>
          )}

          {step.type === 'input' && (
            <View style={styles.inputGroup}>
              {(step as InputStep).fields.map((f) => (
                <View key={String(f.key)} style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  <TextInput
                    style={[styles.input, f.multiline && styles.inputMulti]}
                    value={(config[f.key] as string) ?? ''}
                    onChangeText={(v) => updateField(f.key, v)}
                    placeholder={f.placeholder}
                    placeholderTextColor={Colors.textMuted}
                    multiline={f.multiline}
                    autoCapitalize="sentences"
                    autoCorrect
                  />
                </View>
              ))}
            </View>
          )}

          {step.type === 'choice' && (
            <View style={styles.choiceGroup}>
              {(step as ChoiceStep).options.map((opt) => {
                const selected = config[(step as ChoiceStep).storeKey] === opt.key
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[styles.choiceCard, selected && styles.choiceCardSelected]}
                    onPress={() => handleChoice(opt.key)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.choiceEmoji}>{opt.emoji}</Text>
                    <View style={styles.choiceTextBlock}>
                      <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>
                        {opt.label}
                      </Text>
                      {opt.subtitle ? (
                        <Text style={styles.choiceSub}>{opt.subtitle}</Text>
                      ) : null}
                    </View>
                    <View style={[styles.radio, selected && styles.radioSelected]} />
                  </TouchableOpacity>
                )
              })}
            </View>
          )}

        </Animated.View>
      </ScrollView>

      {/* Footer — only for info & input steps */}
      {step.type !== 'choice' && (
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.continueBtn, !canContinue() && styles.continueBtnDisabled]}
            onPress={handleContinue}
            disabled={!canContinue()}
          >
            <Text style={styles.continueBtnText}>
              {isLast ? 'Launch Mission Control →' : 'Continue →'}
            </Text>
          </TouchableOpacity>
          {stepIdx === 0 && (
            <TouchableOpacity
              style={styles.skipBtn}
              onPress={() => router.replace(currentOrg ? '/(tabs)' : '/org/create')}
            >
              <Text style={styles.skipText}>Skip intro</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },

  // Progress bar
  progressTrack: { height: 3, backgroundColor: Colors.border },
  progressFill:  { height: 3, backgroundColor: Colors.accent },

  // Scroll
  scroll: {
    padding: Space.xl,
    paddingTop: Space.lg,
    gap: Space.xl,
    paddingBottom: 140,
  },

  // Arturito speech bubble
  arturitoRow: {
    flexDirection: 'row',
    gap: Space.md,
    alignItems: 'flex-start',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.accentBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarEmoji: { fontSize: 22 },
  bubble: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    borderTopLeftRadius: Radius.xs,
    padding: Space.md,
    gap: Space.xs,
  },
  bubbleLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.accent,
    letterSpacing: 0.8,
  },
  bubbleText: {
    fontSize: FontSize.lg,
    color: Colors.text,
    lineHeight: 22,
  },

  // Info step
  infoCard: {
    alignItems: 'center',
    gap: Space.lg,
    paddingVertical: Space.xl,
  },
  infoEmoji: { fontSize: 72 },
  infoTitle: {
    fontSize: 26,
    fontWeight: FontWeight.heavy,
    color: Colors.text,
    textAlign: 'center',
    letterSpacing: -0.3,
  },

  // Input step
  inputGroup: { gap: Space.lg },
  fieldBlock:  { gap: Space.xs },
  fieldLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: Space.md,
    color: Colors.text,
    fontSize: FontSize.lg,
  },
  inputMulti: { minHeight: 90, textAlignVertical: 'top' },

  // Choice step
  choiceGroup: { gap: Space.sm },
  choiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: Space.md,
  },
  choiceCardSelected: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accentDim,
  },
  choiceEmoji: { fontSize: 26, width: 34, textAlign: 'center' },
  choiceTextBlock: { flex: 1, gap: 2 },
  choiceLabel: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    color: Colors.text,
  },
  choiceLabelSelected: { color: Colors.accent },
  choiceSub: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    lineHeight: 18,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  radioSelected: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent,
  },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: Space.xl,
    paddingBottom: 34,
    backgroundColor: Colors.bg,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: Space.sm,
  },
  continueBtn: {
    backgroundColor: Colors.accent,
    padding: Space.lg,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  continueBtnDisabled: { opacity: 0.35 },
  continueBtnText: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    color: Colors.white,
  },
  skipBtn:  { padding: Space.sm, alignItems: 'center' },
  skipText: { fontSize: FontSize.base, color: Colors.textMuted },
})
