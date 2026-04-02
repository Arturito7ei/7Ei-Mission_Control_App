import { View, Text, FlatList, StyleSheet, TouchableOpacity, Switch, Alert, RefreshControl, TextInput, Modal } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Button } from '../../components/Button'

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Daily at 8am', cron: '0 8 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Every Monday', cron: '0 8 * * 1' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
]

function cronToHuman(cron: string): string {
  const preset = PRESETS.find(p => p.cron === cron)
  if (preset) return preset.label
  return cron
}

interface ScheduledTask {
  id: string; orgId: string; agentId: string; title: string
  input: string; cronExpression: string; enabled: boolean
  lastRunAt: string | null; nextRunAt: string | null; createdAt: string
}

export default function ScheduledScreen() {
  const { currentOrg, agents } = useStore()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [form, setForm] = useState({ title: '', agentId: '', input: '', cron: '0 8 * * *' })

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/orgs/${currentOrg.id}/scheduled`)
      const data = await res.json()
      setTasks(data.tasks ?? [])
    } catch {}
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const toggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/scheduled/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      })
      setTasks(prev => prev.map(t => t.id === id ? { ...t, enabled: !enabled } : t))
    } catch {}
  }

  const deleteTask = async (id: string) => {
    Alert.alert('Delete', 'Remove this scheduled task?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/scheduled/${id}`, { method: 'DELETE' })
        setTasks(prev => prev.filter(t => t.id !== id))
      }},
    ])
  }

  const handleCreate = async () => {
    if (!form.title.trim() || !form.agentId || !currentOrg) return
    try {
      await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/orgs/${currentOrg.id}/scheduled`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: form.agentId, title: form.title, input: form.input || form.title, cronExpression: form.cron }),
      })
      setModalVisible(false)
      setForm({ title: '', agentId: '', input: '', cron: '0 8 * * *' })
      load()
    } catch (e: any) { Alert.alert('Error', e.message) }
  }

  const getAgentName = (id: string) => agents.find(a => a.id === id)?.name ?? 'Unknown'

  return (
    <View style={styles.container}>
      <FlatList
        data={tasks}
        keyExtractor={t => t.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={<EmptyState emoji="⏰" title="No scheduled tasks" subtitle="Automate recurring work with scheduled agent tasks" />}
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <View style={styles.row}>
              <View style={styles.info}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.meta}>{getAgentName(item.agentId)} · {cronToHuman(item.cronExpression)}</Text>
                {item.lastRunAt && <Text style={styles.lastRun}>Last: {new Date(item.lastRunAt).toLocaleString()}</Text>}
              </View>
              <Switch value={item.enabled} onValueChange={() => toggleEnabled(item.id, item.enabled)} />
              <TouchableOpacity onPress={() => deleteTask(item.id)} style={styles.deleteBtn}>
                <Text style={{ fontSize: 16 }}>🗑️</Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}
      />

      <TouchableOpacity style={styles.fab} onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>New Scheduled Task</Text>
            <TextInput style={styles.input} placeholder="Title" placeholderTextColor={Colors.textMuted} value={form.title} onChangeText={t => setForm(f => ({ ...f, title: t }))} />
            <TextInput style={[styles.input, { minHeight: 60 }]} placeholder="Prompt / instructions" placeholderTextColor={Colors.textMuted} value={form.input} onChangeText={t => setForm(f => ({ ...f, input: t }))} multiline />
            <Text style={styles.label}>Agent</Text>
            <View style={styles.agentPicker}>
              {agents.slice(0, 6).map(a => (
                <TouchableOpacity key={a.id} style={[styles.agentChip, form.agentId === a.id && styles.agentChipActive]} onPress={() => setForm(f => ({ ...f, agentId: a.id }))}>
                  <Text style={{ fontSize: 14 }}>{a.avatarEmoji} {a.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>Schedule</Text>
            <View style={styles.agentPicker}>
              {PRESETS.map(p => (
                <TouchableOpacity key={p.cron} style={[styles.agentChip, form.cron === p.cron && styles.agentChipActive]} onPress={() => setForm(f => ({ ...f, cron: p.cron }))}>
                  <Text style={{ fontSize: 12, color: Colors.text }}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.modalActions}>
              <Button label="Cancel" onPress={() => setModalVisible(false)} variant="secondary" />
              <Button label="Create" onPress={handleCreate} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  list: { padding: Space.lg, gap: Space.sm },
  card: { padding: Space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  info: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700', color: Colors.text },
  meta: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  lastRun: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  deleteBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center', elevation: 4 },
  fabText: { fontSize: 28, fontWeight: '700', color: '#000' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modal: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Space.xl, gap: Space.md },
  modalTitle: { fontSize: 18, fontWeight: '800', color: Colors.text },
  input: { backgroundColor: Colors.surfaceHigh, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  label: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  agentPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  agentChip: { paddingHorizontal: Space.md, paddingVertical: Space.sm, borderRadius: Radius.md, backgroundColor: Colors.surfaceHigh, borderWidth: 1, borderColor: Colors.border },
  agentChipActive: { backgroundColor: Colors.accentDim, borderColor: Colors.accent },
  modalActions: { flexDirection: 'row', gap: Space.md, marginTop: Space.md },
})
