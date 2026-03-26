import { View, Text, FlatList, StyleSheet, TextInput, Alert, TouchableOpacity, Linking } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../../store'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001'

interface Credential { provider: string; maskedKey: string }

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', emoji: '⬟' },
  { id: 'openai', label: 'OpenAI (GPT)', emoji: '◎' },
  { id: 'gemini', label: 'Google (Gemini)', emoji: '✦' },
]

export default function CredentialsScreen() {
  const { currentOrg } = useStore()
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [driveConnected, setDriveConnected] = useState(false)
  const [adding, setAdding] = useState(false)
  const [provider, setProvider] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const res = await fetch(`${BASE}/api/orgs/${currentOrg.id}/credentials`)
      const data = await res.json()
      setCredentials(data.credentials ?? [])
    } catch {}
  }, [currentOrg])

  useEffect(() => { load(); loadDriveStatus() }, [load])

  const loadDriveStatus = useCallback(async () => {
    if (!currentOrg) return
    try {
      const res = await fetch(`${BASE}/api/orgs/${currentOrg.id}/auth/google/status`)
      const data = await res.json()
      setDriveConnected(data.connected ?? false)
    } catch {}
  }, [currentOrg])

  const connectDrive = async () => {
    if (!currentOrg) return
    try {
      const res = await fetch(`${BASE}/api/orgs/${currentOrg.id}/auth/google`)
      const data = await res.json()
      if (data.url) Linking.openURL(data.url)
    } catch (e: any) { Alert.alert('Error', e.message) }
  }

  const handleAdd = async () => {
    if (!apiKey.trim() || !currentOrg) return
    try {
      await fetch(`${BASE}/api/orgs/${currentOrg.id}/credentials`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      })
      setApiKey('')
      setAdding(false)
      load()
    } catch (e: any) { Alert.alert('Error', e.message) }
  }

  const handleDelete = (p: string) => {
    Alert.alert('Remove Key', `Delete ${p} API key?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await fetch(`${BASE}/api/orgs/${currentOrg!.id}/credentials/${p}`, { method: 'DELETE' })
        load()
      }},
    ])
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>API Keys</Text>
        <Button label="+ Add Key" onPress={() => setAdding(true)} variant="secondary" />
      </View>

      <FlatList
        data={credentials}
        keyExtractor={c => c.provider}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No API keys configured</Text>
            <Text style={styles.emptySub}>Add provider keys to enable per-org LLM routing</Text>
          </View>
        }
        renderItem={({ item }) => {
          const info = PROVIDERS.find(p => p.id === item.provider)
          return (
            <Card style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.providerEmoji}>{info?.emoji ?? '🔑'}</Text>
                <View style={styles.cardInfo}>
                  <Text style={styles.providerName}>{info?.label ?? item.provider}</Text>
                  <Text style={styles.maskedKey}>{item.maskedKey}</Text>
                </View>
                <TouchableOpacity onPress={() => handleDelete(item.provider)}>
                  <Text style={{ fontSize: 16 }}>🗑️</Text>
                </TouchableOpacity>
              </View>
            </Card>
          )
        }}
      />

      {/* Google Drive */}
      <View style={styles.driveSection}>
        <Card style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.providerEmoji}>📁</Text>
            <View style={styles.cardInfo}>
              <Text style={styles.providerName}>Google Drive</Text>
              <Text style={styles.maskedKey}>{driveConnected ? 'Connected' : 'Not connected'}</Text>
            </View>
            {driveConnected ? (
              <Text style={{ fontSize: 14, color: Colors.accent }}>✓</Text>
            ) : (
              <Button label="Connect" onPress={connectDrive} variant="secondary" />
            )}
          </View>
        </Card>
      </View>

      {adding && (
        <View style={styles.addForm}>
          <Text style={styles.label}>Provider</Text>
          <View style={styles.providerPicker}>
            {PROVIDERS.map(p => (
              <TouchableOpacity key={p.id} style={[styles.providerChip, provider === p.id && styles.providerChipActive]} onPress={() => setProvider(p.id)}>
                <Text style={{ fontSize: 13, color: provider === p.id ? Colors.accent : Colors.text }}>{p.emoji} {p.id}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>API Key</Text>
          <TextInput style={styles.input} value={apiKey} onChangeText={setApiKey} placeholder="sk-..." placeholderTextColor={Colors.textMuted} secureTextEntry autoCapitalize="none" />
          <View style={styles.formActions}>
            <Button label="Cancel" onPress={() => { setAdding(false); setApiKey('') }} variant="secondary" />
            <Button label="Save Key" onPress={handleAdd} />
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg },
  title: { fontSize: 22, fontWeight: '800', color: Colors.text },
  list: { paddingHorizontal: Space.lg, gap: Space.sm },
  card: { padding: Space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  providerEmoji: { fontSize: 24 },
  cardInfo: { flex: 1 },
  providerName: { fontSize: 15, fontWeight: '600', color: Colors.text },
  maskedKey: { fontSize: 12, color: Colors.textMuted, fontFamily: 'monospace', marginTop: 2 },
  empty: { padding: Space.xl, alignItems: 'center', gap: Space.sm },
  emptyText: { fontSize: 16, fontWeight: '600', color: Colors.text },
  emptySub: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center' },
  addForm: { padding: Space.lg, gap: Space.md, borderTopWidth: 1, borderTopColor: Colors.border, backgroundColor: Colors.surface },
  label: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase' },
  providerPicker: { flexDirection: 'row', gap: Space.xs },
  providerChip: { paddingHorizontal: Space.md, paddingVertical: Space.sm, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border },
  providerChipActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  input: { backgroundColor: Colors.surfaceHigh, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  formActions: { flexDirection: 'row', gap: Space.md },
  driveSection: { paddingHorizontal: Space.lg, marginTop: Space.lg },
})
