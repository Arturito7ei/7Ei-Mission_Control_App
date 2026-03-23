import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, Alert, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { Stack } from 'expo-router'
import { useStore } from '../../store'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ThemedText } from '../../components/ThemedText'

const EVENT_OPTIONS = ['*', 'task.done', 'task.failed', 'agent.active', 'agent.idle', 'message.created']

export default function WebhooksScreen() {
  const { currentOrg } = useStore()
  const { theme } = useTheme()
  const [hooks, setHooks] = useState<any[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', url: '', secret: '', events: ['*'] as string[] })

  const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001'

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const res = await fetch(`${BASE}/api/orgs/${currentOrg.id}/webhooks`)
      const data = await res.json()
      setHooks(data.webhooks ?? [])
    } catch {}
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const handleCreate = async () => {
    if (!currentOrg || !form.name || !form.url) { Alert.alert('Required', 'Name and URL required'); return }
    setCreating(true)
    try {
      const res = await fetch(`${BASE}/api/orgs/${currentOrg.id}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, url: form.url, secret: form.secret || undefined, events: form.events }),
      })
      const data = await res.json()
      if (data.webhook) {
        setHooks(h => [data.webhook, ...h])
        setShowCreate(false)
        setForm({ name: '', url: '', secret: '', events: ['*'] })
      } else Alert.alert('Error', data.error ?? 'Failed')
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setCreating(false) }
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    try {
      const res = await fetch(`${BASE}/api/webhooks/${id}/test`, { method: 'POST' })
      const data = await res.json()
      Alert.alert(data.ok ? '✅ Test sent' : '❌ Test failed', `Status: ${data.status ?? data.error}`)
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setTesting(null) }
  }

  const handleDelete = (hook: any) => {
    Alert.alert('Delete Webhook', `Remove "${hook.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await fetch(`${BASE}/api/webhooks/${hook.id}`, { method: 'DELETE' })
        setHooks(h => h.filter(x => x.id !== hook.id))
      }},
    ])
  }

  const toggleEvent = (ev: string) => {
    setForm(f => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev],
    }))
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: 'Outbound Webhooks' }} />

      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>
          {hooks.length} webhook{hooks.length !== 1 ? 's' : ''}
        </ThemedText>
        <Button label="+ New" onPress={() => setShowCreate(!showCreate)} size="sm" />
      </View>

      {showCreate && (
        <View style={[styles.form, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <ThemedText variant="title" style={{ marginBottom: Space.md }}>New Webhook</ThemedText>
          {([{ k: 'name', label: 'Name', ph: '7Ei → Slack' }, { k: 'url', label: 'Endpoint URL', ph: 'https://hooks.slack.com/...', caps: 'none' as any }, { k: 'secret', label: 'Secret (optional)', ph: 'HMAC signing secret', caps: 'none' as any }] as any[]).map(f => (
            <View key={f.k} style={{ marginBottom: Space.md }}>
              <ThemedText variant="label" style={{ marginBottom: Space.xs }}>{f.label}</ThemedText>
              <TextInput
                style={[styles.input, { backgroundColor: theme.surfaceHigh, borderColor: theme.borderLight, color: theme.text }]}
                value={(form as any)[f.k]} onChangeText={v => setForm(x => ({ ...x, [f.k]: v }))}
                placeholder={f.ph} placeholderTextColor={theme.textMuted}
                autoCapitalize={f.caps ?? 'sentences'}
              />
            </View>
          ))}
          <ThemedText variant="label" style={{ marginBottom: Space.xs }}>Events</ThemedText>
          <View style={styles.eventRow}>
            {EVENT_OPTIONS.map(ev => (
              <TouchableOpacity
                key={ev}
                style={[styles.eventChip, { backgroundColor: form.events.includes(ev) ? theme.accentDim : theme.surfaceHigh, borderColor: form.events.includes(ev) ? theme.accent : theme.borderLight }]}
                onPress={() => toggleEvent(ev)}
              >
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs, color: form.events.includes(ev) ? theme.accent : undefined }}>{ev}</ThemedText>
              </TouchableOpacity>
            ))}
          </View>
          <View style={[styles.formBtns, { marginTop: Space.lg }]}>
            <Button label="Cancel" onPress={() => setShowCreate(false)} variant="secondary" style={{ flex: 1 }} />
            <Button label="Create" onPress={handleCreate} loading={creating} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      <FlatList
        data={hooks}
        keyExtractor={h => h.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        ListEmptyComponent={<EmptyState emoji="🔗" title="No webhooks" subtitle="Create a webhook to receive events from 7Ei in external services" />}
        renderItem={({ item: hook }) => (
          <Card style={styles.hookCard}>
            <View style={styles.hookRow}>
              <View style={styles.hookInfo}>
                <ThemedText variant="body" style={{ fontWeight: FontWeight.semibold }}>{hook.name}</ThemedText>
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs }} numberOfLines={1}>{hook.url}</ThemedText>
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs }}>
                  {(hook.events as string[]).join(', ')} · {hook.enabled ? '• active' : '○ paused'}
                </ThemedText>
              </View>
              <View style={styles.hookActions}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: theme.accentDim, borderColor: theme.accentBorder }]}
                  onPress={() => handleTest(hook.id)}
                  disabled={testing === hook.id}
                >
                  <Text style={{ fontSize: 13, color: theme.accent }}>{testing === hook.id ? '...' : 'Test'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: theme.statusErrorBg, borderColor: theme.borderError }]}
                  onPress={() => handleDelete(hook)}
                >
                  <Text style={{ fontSize: 16 }}>🗑️</Text>
                </TouchableOpacity>
              </View>
            </View>
            {hook.lastTriggeredAt && (
              <ThemedText variant="muted" style={{ fontSize: FontSize.xs, marginTop: Space.xs }}>
                Last triggered: {new Date(hook.lastTriggeredAt).toLocaleString()}
              </ThemedText>
            )}
          </Card>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg, borderBottomWidth: 0.5 },
  form: { padding: Space.lg, borderBottomWidth: 0.5 },
  input: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base },
  eventRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  eventChip: { paddingHorizontal: Space.sm, paddingVertical: Space.xs + 1, borderRadius: Radius.xl, borderWidth: 0.5 },
  formBtns: { flexDirection: 'row', gap: Space.sm },
  list: { padding: Space.lg, gap: Space.sm },
  hookCard: { padding: Space.md },
  hookRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  hookInfo: { flex: 1, gap: 3 },
  hookActions: { flexDirection: 'row', gap: Space.xs },
  actionBtn: { paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.sm, borderWidth: 0.5, alignItems: 'center', justifyContent: 'center' },
})
