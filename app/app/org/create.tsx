import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  Alert,
} from 'react-native'
import { useEffect, useState } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Button } from '../../components/Button'

// ─── Labels for deploy summary ────────────────────────────────────────────────

const PROVIDER_LABEL: Record<string, string> = {
  aws:    '🟠 AWS Bedrock',
  gcp:    '🔵 Google Cloud',
  azure:  '🟦 Microsoft Azure',
  oracle: '🔴 Oracle Cloud',
}

const LLM_LABEL: Record<string, string> = {
  claude: '🧠 Claude',
  gpt4o:  '💬 GPT-4o',
  gemini: '✨ Gemini',
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CreateOrgScreen() {
  const router = useRouter()
  const { setCurrentOrg, setOrgs, orgs, onboardingConfig } = useStore()
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Pre-fill from onboarding wizard if available
  useEffect(() => {
    if (onboardingConfig) {
      if (onboardingConfig.orgName)        setName(onboardingConfig.orgName)
      if (onboardingConfig.orgDescription) setDescription(onboardingConfig.orgDescription)
    }
  }, [onboardingConfig])

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert('Required', 'Organisation name is required')
      return
    }
    setLoading(true)
    try {
      const { org, arturitoId } = await api.orgs.create({
        name: name.trim(),
        description: description || undefined,
        mission:        onboardingConfig?.mission        || undefined,
        culture:        onboardingConfig?.culture        || undefined,
        deployMode:     onboardingConfig?.deployMode     || undefined,
        cloudProvider:  onboardingConfig?.cloudProvider  || undefined,
        preferredLlm:   onboardingConfig?.preferredLlm   || undefined,
        firstAgentRole: onboardingConfig?.firstAgentRole || undefined,
      })
      setOrgs([...orgs, org])
      setCurrentOrg(org)
      if (arturitoId) {
        router.replace(`/agents/${arturitoId}?firstTime=true`)
      } else {
        router.replace('/(tabs)')
      }
    } catch (e: any) {
      Alert.alert('Error', e.message)
    } finally {
      setLoading(false)
    }
  }

  // Build deployment summary from onboarding config
  const deployMode    = onboardingConfig?.deployMode
  const cloudProvider = onboardingConfig?.cloudProvider
  const preferredLlm  = onboardingConfig?.preferredLlm
  const firstAgent    = onboardingConfig?.firstAgentRole

  const hasDeployConfig = deployMode != null

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

      <View style={styles.hero}>
        <Text style={styles.heroEmoji}>🏢</Text>
        <Text style={styles.heroTitle}>Create your organisation</Text>
        <Text style={styles.heroSub}>
          Your virtual office starts here. Add agents, projects, and departments as you grow.
        </Text>
      </View>

      {/* Deployment config summary card — shown when onboarding was completed */}
      {hasDeployConfig && (
        <View style={styles.deployCard}>
          <Text style={styles.deployCardTitle}>⚙️  Deployment Configuration</Text>
          <View style={styles.deployRow}>
            <Text style={styles.deployKey}>Mode</Text>
            <Text style={styles.deployVal}>
              {deployMode === 'cloud' ? '☁️  Cloud' : '💻  Local / On-Premise'}
            </Text>
          </View>
          {cloudProvider && (
            <View style={styles.deployRow}>
              <Text style={styles.deployKey}>Provider</Text>
              <Text style={styles.deployVal}>{PROVIDER_LABEL[cloudProvider] ?? cloudProvider}</Text>
            </View>
          )}
          {preferredLlm && (
            <View style={styles.deployRow}>
              <Text style={styles.deployKey}>Model</Text>
              <Text style={styles.deployVal}>{LLM_LABEL[preferredLlm] ?? preferredLlm}</Text>
            </View>
          )}
          {firstAgent && (
            <View style={styles.deployRow}>
              <Text style={styles.deployKey}>First Agent</Text>
              <Text style={[styles.deployVal, { textTransform: 'capitalize' }]}>
                {firstAgent}
              </Text>
            </View>
          )}
          <Text style={styles.deployNote}>
            You can adjust these anytime in Organisation Settings.
          </Text>
        </View>
      )}

      <View style={styles.field}>
        <Text style={styles.label}>Organisation Name *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. 7Ei, Acme Corp, My Startup"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="words"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.inputMulti]}
          value={description}
          onChangeText={setDescription}
          placeholder="What does this organisation do?"
          placeholderTextColor={Colors.textMuted}
          multiline
        />
      </View>

      <Button label="Create Organisation" onPress={handleCreate} loading={loading} />
    </ScrollView>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:   { flex: 1, backgroundColor: Colors.bg },
  content:  { padding: Space.xl, gap: Space.xl },

  // Hero
  hero:      { alignItems: 'center', gap: Space.md, paddingVertical: Space.xl },
  heroEmoji: { fontSize: 56 },
  heroTitle: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.heavy,
    color: Colors.text,
    textAlign: 'center',
  },
  heroSub: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Deploy summary card
  deployCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.accentBorder,
    borderRadius: Radius.lg,
    padding: Space.lg,
    gap: Space.sm,
  },
  deployCardTitle: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    marginBottom: Space.xs,
  },
  deployRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  deployKey: {
    fontSize: FontSize.base,
    color: Colors.textMuted,
  },
  deployVal: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    color: Colors.text,
  },
  deployNote: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: Space.xs,
    lineHeight: 16,
  },

  // Form fields
  field: { gap: Space.xs },
  label: {
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
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
})
