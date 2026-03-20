import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native'
import { useState } from 'react'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Button } from '../../components/Button'
import { AgentAvatar } from '../../components/AgentAvatar'

const PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'] as const
const COLUMNS = ['todo', 'in_progress', 'blocked', 'done'] as const

export default function CreateTaskScreen() {
  const router = useRouter()
  const { projectId } = useLocalSearchParams<{ projectId?: string }>()
  const { currentOrg, agents, addTask } = useStore()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ title: '', input: '', agentId: '', priority: 'medium' as string, kanbanColumn: 'todo' as string })

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleCreate = async () => {
    if (!form.title.trim()) { Alert.alert('Required', 'Task title is required'); return }
    if (!form.agentId) { Alert.alert('Required', 'Select an agent'); return }
    if (!currentOrg) return
    setLoading(true)
    try {
      const { task } = await api.tasks.create(currentOrg.id, {
        agentId: form.agentId,
        projectId: projectId ?? undefined,
        title: form.title.trim(),
        input: form.input || undefined,
        priority: form.priority,
        kanbanColumn: form.kanbanColumn,
      })
      addTask(task)
      router.back()
    } catch (e: any) {
      Alert.alert('Error', e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.field}>
        <Text style={styles.label}>Task Title *</Text>
        <TextInput style={styles.input} value={form.title} onChangeText={v => set('title', v)} placeholder="What needs to be done?" placeholderTextColor={Colors.textMuted} />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Instructions for Agent</Text>
        <TextInput style={[styles.input, styles.inputMulti]} value={form.input} onChangeText={v => set('input', v)} placeholder="Detailed instructions, context, expected output..." placeholderTextColor={Colors.textMuted} multiline />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Assign to Agent *</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {agents.map(agent => (
            <TouchableOpacity key={agent.id} style={[styles.agentChip, form.agentId === agent.id && styles.agentChipActive]} onPress={() => set('agentId', agent.id)}>
              <AgentAvatar emoji={agent.avatarEmoji} size={36} />
              <Text style={[styles.agentChipName, form.agentId === agent.id && styles.agentChipNameActive]}>{agent.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Priority</Text>
        <View style={styles.chipRow}>
          {PRIORITIES.map(p => (
            <TouchableOpacity key={p} style={[styles.chip, form.priority === p && styles.chipActive]} onPress={() => set('priority', p)}>
              <Text style={[styles.chipText, form.priority === p && styles.chipTextActive]}>{p}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Column</Text>
        <View style={styles.chipRow}>
          {COLUMNS.map(c => (
            <TouchableOpacity key={c} style={[styles.chip, form.kanbanColumn === c && styles.chipActive]} onPress={() => set('kanbanColumn', c)}>
              <Text style={[styles.chipText, form.kanbanColumn === c && styles.chipTextActive]}>{c.replace('_', ' ')}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      <Button label="Create Task" onPress={handleCreate} loading={loading} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg, paddingBottom: 48 },
  field: { gap: Space.sm },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  inputMulti: { minHeight: 100, textAlignVertical: 'top' },
  agentChip: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, alignItems: 'center', marginRight: Space.sm, gap: 4, minWidth: 80 },
  agentChipActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  agentChipName: { fontSize: 11, color: Colors.textSecondary, textAlign: 'center', fontWeight: '500' },
  agentChipNameActive: { color: Colors.accent, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  chip: { paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.xl, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.accentDim, borderColor: Colors.accent },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500', textTransform: 'capitalize' },
  chipTextActive: { color: Colors.accent, fontWeight: '700' },
})
