import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native'
import { useState, useEffect } from 'react'
import { useRouter, useLocalSearchParams, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Button } from '../../components/Button'

const LLM_MODELS = [
  { label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
  { label: 'Claude Opus 4', value: 'claude-opus-4-6' },
  { label: 'Claude Haiku', value: 'claude-haiku-4-5-20251001' },
]

export default function EditAgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { agents, updateAgent } = useStore()
  const agent = agents.find(a => a.id === id)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    name: '', role: '', personality: '', cv: '', termsOfReference: '',
    llmModel: 'claude-sonnet-4-20250514', avatarEmoji: '🤖',
    agentType: 'standard' as 'standard' | 'advisor', advisorPersona: '',
  })

  useEffect(() => {
    if (agent) {
      setForm({
        name: agent.name, role: agent.role,
        personality: agent.personality ?? '',
        cv: (agent as any).cv ?? '',
        termsOfReference: (agent as any).termsOfReference ?? '',
        llmModel: agent.llmModel,
        avatarEmoji: agent.avatarEmoji,
        agentType: agent.agentType as any,
        advisorPersona: agent.advisorPersona ?? '',
      })
    }
  }, [agent])

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!form.name.trim() || !form.role.trim()) { Alert.alert('Required', 'Name and role are required'); return }
    setLoading(true)
    try {
      await api.agents.update(id!, {
        name: form.name.trim(), role: form.role.trim(),
        personality: form.personality || undefined,
        cv: form.cv || undefined,
        termsOfReference: form.termsOfReference || undefined,
        llmModel: form.llmModel, avatarEmoji: form.avatarEmoji,
        agentType: form.agentType,
        advisorPersona: form.agentType === 'advisor' ? form.advisorPersona : undefined,
      } as any)
      updateAgent(id!, { name: form.name, role: form.role, llmModel: form.llmModel, avatarEmoji: form.avatarEmoji })
      router.back()
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setLoading(false) }
  }

  if (!agent) return null

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: `Edit ${agent.name}` }} />

      {[{ key: 'name', label: 'Name *', placeholder: agent.name },
        { key: 'role', label: 'Role *', placeholder: agent.role },
        { key: 'personality', label: 'Personality', placeholder: 'Communication style...', multiline: true },
        { key: 'cv', label: 'Background', placeholder: 'Professional background...', multiline: true },
        { key: 'termsOfReference', label: 'Terms of Reference', placeholder: 'Scope of responsibilities...', multiline: true },
        ...(form.agentType === 'advisor' ? [{ key: 'advisorPersona', label: 'Advisor Persona', placeholder: 'e.g. Steve Jobs...', multiline: true }] : []),
      ].map((field: any) => (
        <View key={field.key} style={styles.field}>
          <Text style={styles.label}>{field.label}</Text>
          <TextInput
            style={[styles.input, field.multiline && styles.inputMulti]}
            value={(form as any)[field.key]}
            onChangeText={v => set(field.key, v)}
            placeholder={field.placeholder}
            placeholderTextColor={Colors.textMuted}
            multiline={field.multiline}
          />
        </View>
      ))}

      <View style={styles.field}>
        <Text style={styles.label}>LLM Model</Text>
        {LLM_MODELS.map(m => (
          <TouchableOpacity key={m.value} style={[styles.modelBtn, form.llmModel === m.value && styles.modelBtnActive]} onPress={() => set('llmModel', m.value)}>
            <View style={[styles.modelDot, form.llmModel === m.value && styles.modelDotActive]} />
            <Text style={[styles.modelText, form.llmModel === m.value && styles.modelTextActive]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Button label="Save Changes" onPress={handleSave} loading={loading} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg, paddingBottom: 48 },
  field: { gap: Space.xs },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  modelBtn: { flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.md, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, marginBottom: Space.xs },
  modelBtnActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  modelDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: Colors.border },
  modelDotActive: { borderColor: Colors.accent, backgroundColor: Colors.accent },
  modelText: { fontSize: 14, color: Colors.textSecondary },
  modelTextActive: { color: Colors.accent, fontWeight: '600' },
})
