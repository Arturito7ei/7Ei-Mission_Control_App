import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native'
import { useState, useEffect } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Button } from '../../components/Button'

const LLM_MODELS = [
  { label: 'Claude Sonnet 4 (default)', value: 'claude-sonnet-4-20250514' },
  { label: 'Claude Opus 4', value: 'claude-opus-4-6' },
  { label: 'Claude Haiku', value: 'claude-haiku-4-5-20251001' },
]

const EMOJI_OPTIONS = ['🎯', '💻', '📣', '⚙️', '📊', '🔬', '🎖️', '🤖', '🧠', '🚀', '🌟', '🔥', '💼', '🌎', '⚡']

export default function CreateAgentScreen() {
  const router = useRouter()
  const { currentOrg, agents, setAgents } = useStore()
  const [loading, setLoading] = useState(false)
  const [templates, setTemplates] = useState<Record<string, any>>({})
  const [form, setForm] = useState({
    name: '', role: '', personality: '', cv: '', termsOfReference: '',
    llmModel: 'claude-sonnet-4-20250514', avatarEmoji: '🤖',
    agentType: 'standard' as 'standard' | 'advisor', advisorPersona: '',
  })

  useEffect(() => {
    api.agents.templates().then(r => setTemplates(r.templates))
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
        personality: form.personality || undefined,
        cv: form.cv || undefined,
        termsOfReference: form.termsOfReference || undefined,
        llmModel: form.llmModel,
        avatarEmoji: form.avatarEmoji,
        agentType: form.agentType,
        advisorPersona: form.agentType === 'advisor' ? form.advisorPersona : undefined,
      })
      setAgents([...agents, agent])
      router.replace(`/agents/${agent.id}`)
    } catch (e: any) {
      Alert.alert('Error', e.message)
    } finally {
      setLoading(false)
    }
  }

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Templates */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Start from a template</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {Object.entries(templates).map(([key, t]: any) => (
            <TouchableOpacity key={key} style={styles.templateChip} onPress={() => applyTemplate(key)}>
              <Text style={styles.templateEmoji}>{t.avatarEmoji}</Text>
              <Text style={styles.templateLabel}>{t.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Emoji picker */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Avatar</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {EMOJI_OPTIONS.map(e => (
            <TouchableOpacity key={e} style={[styles.emojiBtn, form.avatarEmoji === e && styles.emojiBtnActive]} onPress={() => set('avatarEmoji', e)}>
              <Text style={styles.emojiText}>{e}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Type */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Agent Type</Text>
        <View style={styles.typeRow}>
          {(['standard', 'advisor'] as const).map(t => (
            <TouchableOpacity key={t} style={[styles.typeBtn, form.agentType === t && styles.typeBtnActive]} onPress={() => set('agentType', t)}>
              <Text style={[styles.typeText, form.agentType === t && styles.typeTextActive]}>{t === 'standard' ? '🤖 Standard' : '🎖️ Advisor'}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Fields */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Identity</Text>
        {([
          { key: 'name', label: 'Name *', placeholder: 'e.g. Arturito' },
          { key: 'role', label: 'Role *', placeholder: 'e.g. Chief of Staff' },
          { key: 'personality', label: 'Personality & Communication Style', placeholder: 'Direct, strategic...', multiline: true },
          { key: 'cv', label: 'Background / CV', placeholder: 'Professional background...', multiline: true },
          { key: 'termsOfReference', label: 'Terms of Reference', placeholder: 'Scope of responsibilities...', multiline: true },
          ...(form.agentType === 'advisor' ? [{ key: 'advisorPersona', label: 'Advisor Persona', placeholder: 'e.g. Steve Jobs — co-founder of Apple, visionary product leader...', multiline: true }] : []),
        ] as any[]).map(({ key, label, placeholder, multiline }) => (
          <View key={key} style={styles.field}>
            <Text style={styles.label}>{label}</Text>
            <TextInput
              style={[styles.input, multiline && styles.inputMulti]}
              value={(form as any)[key]}
              onChangeText={v => set(key, v)}
              placeholder={placeholder}
              placeholderTextColor={Colors.textMuted}
              multiline={multiline}
            />
          </View>
        ))}
      </View>

      {/* LLM */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>LLM Model</Text>
        {LLM_MODELS.map(m => (
          <TouchableOpacity key={m.value} style={[styles.modelBtn, form.llmModel === m.value && styles.modelBtnActive]} onPress={() => set('llmModel', m.value)}>
            <View style={[styles.modelDot, form.llmModel === m.value && styles.modelDotActive]} />
            <Text style={[styles.modelLabel, form.llmModel === m.value && styles.modelLabelActive]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Button label="Create Agent" onPress={handleCreate} loading={loading} style={styles.createBtn} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.xl, paddingBottom: 48 },
  section: { gap: Space.sm },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  templateChip: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, alignItems: 'center', marginRight: Space.sm, gap: 4, minWidth: 72 },
  templateEmoji: { fontSize: 24 },
  templateLabel: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  emojiBtn: { width: 44, height: 44, borderRadius: Radius.sm, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginRight: Space.xs, borderWidth: 1, borderColor: Colors.border },
  emojiBtnActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  emojiText: { fontSize: 22 },
  typeRow: { flexDirection: 'row', gap: Space.sm },
  typeBtn: { flex: 1, padding: Space.md, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, alignItems: 'center' },
  typeBtnActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  typeText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
  typeTextActive: { color: Colors.accent },
  field: { gap: Space.xs },
  label: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  modelBtn: { flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.md, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  modelBtnActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  modelDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: Colors.border },
  modelDotActive: { borderColor: Colors.accent, backgroundColor: Colors.accent },
  modelLabel: { fontSize: 14, color: Colors.textSecondary },
  modelLabelActive: { color: Colors.accent, fontWeight: '600' },
  createBtn: { marginTop: Space.sm },
})
