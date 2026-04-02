import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, Alert, RefreshControl, ScrollView } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { Stack } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { AgentAvatar } from '../../components/AgentAvatar'
import { ThemedText } from '../../components/ThemedText'
import { StatusBadge } from '../../components/StatusBadge'

const PRESETS = [
  { label: 'Every hour',   cron: '0 * * * *' },
  { label: 'Daily 8am',    cron: '0 8 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Every Monday', cron: '0 8 * * 1' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
]

export default function ScheduledScreen() {
  const { currentOrg, agents } = useStore()
  const { theme } = useTheme()
  const [tasks, setTasks] = useState<any[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ agentId: '', title: '', input: '', cron: '0 9 * * 1-5' })
  const [nextRun, setNextRun] = useState<string | null>(null)

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

  const previewCron = async (cron: string) => {
    try {
      const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/scheduled/preview?cron=${encodeURIComponent(cron)}`)
      const data = await res.json()
      if (data.next) setNextRun(new Date(data.next).toLocaleString())
    } catch {}
  }

  const handleCreate = async () => {
    if (!currentOrg || !form.agentId || !form.title || !form.cron) {
      Alert.alert('Required', 'Agent, title and cron expression required'); return
    }
    setCreating(true)
    try {
      const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/orgs/${currentOrg.id}/scheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: form.agentId, title: form.title, input: form.input || undefined, cron: form.cron }),
      })
      const data = await res.json()
      if (data.task) {
        setTasks(t => [data.task, ...t])
        setShowCreate(false)
        setForm({ agentId: '', title: '', input: '', cron: '0 9 * * 1-5' })
      } else Alert.alert('Error', data.error ?? 'Failed to create')
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setCreating(false) }
  }

  const toggleEnabled = async (task: any) => {
    const next = task.enabled === 1 ? 0 : 1
    await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/scheduled/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next === 1 }),
    })
    setTasks(tt => tt.map(t => t.id === task.id ? { ...t, enabled: next } : t))
  }

  const handleDelete = (task: any) => {
    Alert.alert('Delete Schedule', `Remove "${task.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await fetch(`${process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'}/api/scheduled/${task.id}`, { method: 'DELETE' })
        setTasks(tt => tt.filter(t => t.id !== task.id))
      }},
    ])
  }

  const agentMap = new Map(agents.map(a => [a.id, a]))
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: 'Scheduled Tasks' }} />

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>
          {tasks.length} schedule{tasks.length !== 1 ? 's' : ''}
        </ThemedText>
        <Button label="+ New" onPress={() => setShowCreate(!showCreate)} size="sm" />
      </View>

      {/* Create form */}
      {showCreate && (
        <ScrollView style={styles.formScroll} contentContainerStyle={[styles.form, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <ThemedText variant="title" style={{ marginBottom: Space.md }}>New Scheduled Task</ThemedText>

          {/* Agent picker */}
          <ThemedText variant="label" style={{ marginBottom: Space.xs }}>Assign to agent</ThemedText>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Space.md }}>
            {agents.map(a => (
              <TouchableOpacity
                key={a.id}
                style={[styles.agentChip, { backgroundColor: form.agentId === a.id ? theme.accentDim : theme.surfaceHigh, borderColor: form.agentId === a.id ? theme.accent : theme.borderLight }]}
                onPress={() => set('agentId', a.id)}
              >
                <Text style={{ fontSize: 18 }}>{a.avatarEmoji}</Text>
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs }}>{a.name}</ThemedText>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <ThemedText variant="label" style={{ marginBottom: Space.xs }}>Task title</ThemedText>
          <TextInput
            style={[styles.input, { backgroundColor: theme.surfaceHigh, borderColor: theme.borderLight, color: theme.text }]}
            value={form.title} onChangeText={v => set('title', v)}
            placeholder="Daily standup report" placeholderTextColor={theme.textMuted}
          />

          <ThemedText variant="label" style={{ marginTop: Space.md, marginBottom: Space.xs }}>Instructions for agent</ThemedText>
          <TextInput
            style={[styles.input, styles.inputMulti, { backgroundColor: theme.surfaceHigh, borderColor: theme.borderLight, color: theme.text }]}
            value={form.input} onChangeText={v => set('input', v)}
            placeholder="Summarise today's tasks and send a briefing" placeholderTextColor={theme.textMuted}
            multiline
          />

          <ThemedText variant="label" style={{ marginTop: Space.md, marginBottom: Space.xs }}>Schedule (cron)</ThemedText>
          <View style={styles.presetRow}>
            {PRESETS.map(p => (
              <TouchableOpacity
                key={p.cron}
                style={[styles.presetChip, { backgroundColor: form.cron === p.cron ? theme.accentDim : theme.surfaceHigh, borderColor: form.cron === p.cron ? theme.accent : theme.borderLight }]}
                onPress={() => { set('cron', p.cron); previewCron(p.cron) }}
              >
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs, color: form.cron === p.cron ? theme.accent : undefined }}>
                  {p.label}
                </ThemedText>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={[styles.input, { backgroundColor: theme.surfaceHigh, borderColor: theme.borderLight, color: theme.text, marginTop: Space.sm, fontFamily: 'monospace' }]}
            value={form.cron} onChangeText={v => { set('cron', v); previewCron(v) }}
            placeholder="0 9 * * 1-5" placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
          />
          {nextRun && <ThemedText variant="muted" style={{ marginTop: Space.xs }}>Next run: {nextRun}</ThemedText>}

          <View style={[styles.formBtns, { marginTop: Space.lg }]}>
            <Button label="Cancel" onPress={() => setShowCreate(false)} variant="secondary" style={{ flex: 1 }} />
            <Button label="Create" onPress={handleCreate} loading={creating} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      )}

      <FlatList
        data={tasks}
        keyExtractor={t => t.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        ListEmptyComponent={<EmptyState emoji="⏰" title="No scheduled tasks" subtitle="Create a schedule to run agents automatically" />}
        renderItem={({ item: task }) => {
          const agent = agentMap.get(task.agentId)
          const isEnabled = task.enabled === 1
          return (
            <Card style={styles.taskCard}>
              <View style={styles.taskRow}>
                {agent && <AgentAvatar emoji={agent.avatarEmoji} size={36} status={isEnabled ? 'active' : 'idle'} />}
                <View style={styles.taskInfo}>
                  <ThemedText variant="body" style={{ fontWeight: FontWeight.semibold }}>{task.title}</ThemedText>
                  <ThemedText variant="muted" style={{ fontFamily: 'monospace', fontSize: FontSize.xs }}>{task.cron}</ThemedText>
                  {task.nextRunAt && (
                    <ThemedText variant="muted" style={{ fontSize: FontSize.xs }}>
                      Next: {new Date(task.nextRunAt).toLocaleString()}
                    </ThemedText>
                  )}
                </View>
                <View style={styles.taskActions}>
                  <TouchableOpacity
                    style={[styles.toggleBtn, { backgroundColor: isEnabled ? theme.accentDim : theme.surfaceHigh, borderColor: isEnabled ? theme.accent : theme.borderLight }]}
                    onPress={() => toggleEnabled(task)}
                  >
                    <Text style={{ fontSize: 16 }}>{isEnabled ? '⏸️' : '▶️'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.toggleBtn, { backgroundColor: theme.statusErrorBg, borderColor: theme.borderError }]} onPress={() => handleDelete(task)}>
                    <Text style={{ fontSize: 16 }}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {task.runCount > 0 && (
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs, marginTop: Space.xs }}>
                  Ran {task.runCount} time{task.runCount !== 1 ? 's' : ''}
                  {task.lastRunAt ? ` · last ${new Date(task.lastRunAt).toLocaleDateString()}` : ''}
                </ThemedText>
              )}
            </Card>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg, borderBottomWidth: 0.5 },
  formScroll: { maxHeight: 480 },
  form: { padding: Space.lg, borderBottomWidth: 0.5 },
  agentChip: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.sm, alignItems: 'center', marginRight: Space.sm, gap: 4, minWidth: 64 },
  input: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base },
  inputMulti: { minHeight: 72, textAlignVertical: 'top' },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  presetChip: { paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.xl, borderWidth: 0.5 },
  formBtns: { flexDirection: 'row', gap: Space.sm },
  list: { padding: Space.lg, gap: Space.sm },
  taskCard: { padding: Space.md },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  taskInfo: { flex: 1, gap: 3 },
  taskActions: { flexDirection: 'row', gap: Space.xs },
  toggleBtn: { width: 34, height: 34, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5 },
})
