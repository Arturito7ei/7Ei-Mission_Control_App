import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native'
import { useState, useEffect } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ThemedText } from '../../components/ThemedText'

const EMOJI_OPTIONS = ['🎯', '💻', '📣', '⚙️', '📊', '🔬', '🎖️', '🤖', '🧠', '🚀', '🌟', '🔥', '📱', '🌍', '⚡']

export default function CreateAgentScreen() {
  const router = useRouter()
  const { currentOrg, agents, setAgents } = useStore()
  const { theme } = useTheme()
  const [loading, setLoading] = useState(false)
  const [templates, setTemplates] = useState<Record<string, any>>({})
  const [modelCatalogue, setModelCatalogue] = useState<Record<string, any[]>>({})
  const [form, setForm] = useState({
    name: '', role: '', personality: '', cv: '', termsOfReference: '',
    llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514',
    avatarEmoji: '🤖', agentType: 'standard' as 'standard' | 'advisor', advisorPersona: '',
  })

  useEffect(() => {
    api.agents.templates().then(r => setTemplates(r.templates))
    fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/models`)
      .then(r => r.json()).then(d => setModelCatalogue(d.models ?? {}))
      .catch(() => setModelCatalogue({
        anthropic: [
          { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', tier: 'balanced' },
          { id: 'claude-opus-4-6', label: 'Claude Opus 4', tier: 'power' },
          { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku', tier: 'fast' },
        ],
      }))
  }, [])

  const applyTemplate = (key: string) => {
    const t = templates[key]
    if (!t) return
    setForm(f => ({ ...f, name: t.name, role: t.role, personality: t.personality ?? '', avatarEmoji: t.avatarEmoji, agentType: t.agentType ?? 'standard' }))
  }

  const handleCreate = async () => {
    if (!form.name.trim() || !form.role.trim()) { Alert.alert('Required', 'Name and role are required'); return }
    if (!currentOrg) { Alert.alert('No org', 'Select an org first'); return }
    setLoading(true)
    try {
      const { agent } = await api.agents.create(currentOrg.id, {
        name: form.name.trim(), role: form.role.trim(),
        personality: form.personality || undefined, cv: form.cv || undefined,
        termsOfReference: form.termsOfReference || undefined,
        llmProvider: form.llmProvider, llmModel: form.llmModel,
        avatarEmoji: form.avatarEmoji, agentType: form.agentType,
        advisorPersona: form.agentType === 'advisor' ? form.advisorPersona : undefined,
      })
      setAgents([...agents, agent])
      router.replace(`/agents/${agent.id}`)
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setLoading(false) }
  }

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))
  const providerModels = modelCatalogue[form.llmProvider] ?? []

  return (
    <ScrollView style={[styles.scroll, { backgroundColor: theme.bg }]} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

      {/* Templates */}
      <View style={styles.section}>
        <ThemedText variant="label">Start from a template</ThemedText>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: Space.sm }}>
          {Object.entries(templates).map(([key, t]: any) => (
            <TouchableOpacity key={key} style={[styles.templateChip, { backgroundColor: theme.surface, borderColor: theme.borderLight }]} onPress={() => applyTemplate(key)}>
              <Text style={styles.templateEmoji}>{t.avatarEmoji}</Text>
              <ThemedText variant="muted" style={{ fontSize: FontSize.xs }}>{t.name}</ThemedText>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Avatar */}
      <View style={styles.section}>
        <ThemedText variant="label">Avatar</ThemedText>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: Space.sm }}>
          {EMOJI_OPTIONS.map(e => (
            <TouchableOpacity
              key={e}
              style={[styles.emojiBtn, { backgroundColor: form.avatarEmoji === e ? theme.accentDim : theme.surface, borderColor: form.avatarEmoji === e ? theme.accent : theme.borderLight }]}
              onPress={() => set('avatarEmoji', e)}
            >
              <Text style={{ fontSize: 22 }}>{e}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Agent type */}
      <View style={styles.section}>
        <ThemedText variant="label">Agent Type</ThemedText>
        <View style={[styles.typeRow, { marginTop: Space.sm }]}>
          {(['standard', 'advisor'] as const).map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.typeBtn, { backgroundColor: form.agentType === t ? theme.accentDim : theme.surface, borderColor: form.agentType === t ? theme.accent : theme.borderLight }]}
              onPress={() => set('agentType', t)}
            >
              <Text style={[styles.typeBtnText, { color: form.agentType === t ? theme.accent : theme.textSecondary }]}>
                {t === 'standard' ? '🤖 Standard' : '🎖️ Advisor'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Identity fields */}
      <View style={styles.section}>
        <ThemedText variant="label">Identity</ThemedText>
        {([
          { key: 'name', label: 'Name *', placeholder: 'e.g. Arturito' },
          { key: 'role', label: 'Role *', placeholder: 'e.g. Chief of Staff' },
          { key: 'personality', label: 'Communication Style', placeholder: 'Direct, strategic...', multiline: true },
          { key: 'cv', label: 'Background', placeholder: 'Professional background...', multiline: true },
          { key: 'termsOfReference', label: 'Terms of Reference', placeholder: 'Scope...', multiline: true },
          ...(form.agentType === 'advisor' ? [{ key: 'advisorPersona', label: 'Advisor Persona', placeholder: 'e.g. Steve Jobs — co-founder...', multiline: true }] : []),
        ] as any[]).map(({ key, label, placeholder, multiline }) => (
          <View key={key} style={{ marginTop: Space.md }}>
            <ThemedText variant="secondary" style={{ fontSize: FontSize.sm, marginBottom: Space.xs }}>{label}</ThemedText>
            <TextInput
              style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.borderLight, color: theme.text }, multiline && styles.inputMulti]}
              value={(form as any)[key]}
              onChangeText={v => set(key, v)}
              placeholder={placeholder}
              placeholderTextColor={theme.textMuted}
              multiline={multiline}
            />
          </View>
        ))}
      </View>

      {/* LLM Provider */}
      <View style={styles.section}>
        <ThemedText variant="label">LLM Provider</ThemedText>
        <View style={[styles.typeRow, { marginTop: Space.sm }]}>
          {Object.keys(modelCatalogue).map(provider => (
            <TouchableOpacity
              key={provider}
              style={[styles.typeBtn, { backgroundColor: form.llmProvider === provider ? theme.accentDim : theme.surface, borderColor: form.llmProvider === provider ? theme.accent : theme.borderLight }]}
              onPress={() => {
                set('llmProvider', provider)
                const firstModel = modelCatalogue[provider]?.[0]?.id ?? 'claude-sonnet-4-20250514'
                set('llmModel', firstModel)
              }}
            >
              <Text style={[styles.typeBtnText, { color: form.llmProvider === provider ? theme.accent : theme.textSecondary }]}>
                {provider === 'anthropic' ? '⬟ Anthropic' : provider === 'openai' ? '◎ OpenAI' : '✦ Google'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Model */}
      <View style={styles.section}>
        <ThemedText variant="label">Model</ThemedText>
        {providerModels.map((m: any) => (
          <TouchableOpacity
            key={m.id}
            style={[styles.modelBtn, { backgroundColor: form.llmModel === m.id ? theme.accentDim : theme.surface, borderColor: form.llmModel === m.id ? theme.accent : theme.borderLight }]}
            onPress={() => set('llmModel', m.id)}
          >
            <View style={[styles.modelDot, { borderColor: form.llmModel === m.id ? theme.accent : theme.borderLight, backgroundColor: form.llmModel === m.id ? theme.accent : 'transparent' }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.modelLabel, { color: form.llmModel === m.id ? theme.accent : theme.textSecondary }]}>{m.label}</Text>
              <Text style={[styles.modelTier, { color: theme.textMuted }]}>{m.tier}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>

      <Button label="Create Agent" onPress={handleCreate} loading={loading} style={{ marginTop: Space.sm }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Space.lg, gap: Space.xl, paddingBottom: 48 },
  section: {},
  templateChip: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, alignItems: 'center', marginRight: Space.sm, gap: 4, minWidth: 72 },
  templateEmoji: { fontSize: 24 },
  emojiBtn: { width: 44, height: 44, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', marginRight: Space.xs, borderWidth: 0.5 },
  typeRow: { flexDirection: 'row', gap: Space.sm, flexWrap: 'wrap' },
  typeBtn: { flex: 1, minWidth: 100, padding: Space.md, borderRadius: Radius.md, borderWidth: 0.5, alignItems: 'center' },
  typeBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  input: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  modelBtn: { flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.md, borderRadius: Radius.md, borderWidth: 0.5, marginTop: Space.xs },
  modelDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  modelLabel: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  modelTier: { fontSize: FontSize.xs, marginTop: 2, textTransform: 'capitalize' },
})
