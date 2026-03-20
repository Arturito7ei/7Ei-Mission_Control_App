import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, Alert, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useLocalSearchParams, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api, MemoryEntry } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'

export default function MemoryScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>()
  const { agents } = useStore()
  const agent = agents.find(a => a.id === agentId)
  const [memory, setMemory] = useState<Record<string, MemoryEntry>>({})
  const [count, setCount] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [addKey, setAddKey] = useState('')
  const [addValue, setAddValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(async () => {
    if (!agentId) return
    try {
      const { memory: m, count: c } = await api.agents.memory.get(agentId)
      setMemory(m); setCount(c)
    } catch (e) { console.error(e) }
  }, [agentId])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const handleAdd = async () => {
    if (!addKey.trim() || !addValue.trim()) { Alert.alert('Required', 'Key and value required'); return }
    setAdding(true)
    try {
      await api.agents.memory.set(agentId!, addKey.trim(), addValue.trim())
      setAddKey(''); setAddValue(''); setShowAdd(false); await load()
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setAdding(false) }
  }

  const handleDelete = (key: string) => {
    Alert.alert('Delete Memory', `Remove "${key}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await api.agents.memory.delete(agentId!, key); await load() } },
    ])
  }

  const handleClear = () => {
    Alert.alert('Clear All Memory', `Erase all ${count} memories?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear All', style: 'destructive', onPress: async () => { await api.agents.memory.clear(agentId!); await load() } },
    ])
  }

  const entries = Object.values(memory).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: `${agent?.name ?? 'Agent'} Memory` }} />
      <View style={styles.header}>
        <View>
          <Text style={styles.agentName}>{agent?.avatarEmoji} {agent?.name}</Text>
          <Text style={styles.memCount}>{count} memory {count === 1 ? 'entry' : 'entries'}</Text>
        </View>
        <View style={styles.headerBtns}>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowAdd(!showAdd)}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </TouchableOpacity>
          {count > 0 && <TouchableOpacity style={styles.clearBtn} onPress={handleClear}><Text style={styles.clearBtnText}>Clear all</Text></TouchableOpacity>}
        </View>
      </View>

      {showAdd && (
        <Card style={styles.addForm}>
          <Text style={styles.addTitle}>Add Memory</Text>
          <TextInput style={styles.input} value={addKey} onChangeText={setAddKey} placeholder="Key (e.g. user_name, preferred_language)" placeholderTextColor={Colors.textMuted} />
          <TextInput style={[styles.input, styles.multiInput]} value={addValue} onChangeText={setAddValue} placeholder="Value" placeholderTextColor={Colors.textMuted} multiline />
          <View style={styles.addFormBtns}>
            <Button label="Cancel" onPress={() => setShowAdd(false)} variant="secondary" style={{ flex: 1 }} />
            <Button label="Save" onPress={handleAdd} loading={adding} style={{ flex: 1 }} />
          </View>
        </Card>
      )}

      {count === 0 && !showAdd && (
        <Card style={styles.explainer}>
          <Text style={styles.explainerTitle}>🧠 How memory works</Text>
          <Text style={styles.explainerText}>Agents save memories automatically when they write{' '}<Text style={styles.code}>[REMEMBER: key = value]</Text>{' '}in responses. These are injected into every future conversation.</Text>
        </Card>
      )}

      <FlatList
        data={entries}
        keyExtractor={e => e.key}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={count === 0 && !showAdd ? <EmptyState emoji="🧠" title="No memories yet" subtitle="Start a conversation to build context." /> : null}
        renderItem={({ item: entry }) => (
          <Card style={styles.memCard}>
            <View style={styles.memRow}>
              <View style={styles.memInfo}>
                <Text style={styles.memKey}>{entry.key}</Text>
                <Text style={styles.memValue}>{entry.value}</Text>
                <Text style={styles.memDate}>Updated {new Date(entry.updatedAt).toLocaleDateString()}</Text>
              </View>
              <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(entry.key)}>
                <Text style={styles.deleteBtnText}>🗑️</Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg, borderBottomWidth: 1, borderBottomColor: Colors.border },
  agentName: { fontSize: 18, fontWeight: '700', color: Colors.text },
  memCount: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  headerBtns: { flexDirection: 'row', gap: Space.sm },
  addBtn: { backgroundColor: Colors.accent, paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.md },
  addBtnText: { fontSize: 13, fontWeight: '700', color: '#000' },
  clearBtn: { backgroundColor: Colors.surfaceHigh, paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.error + '44' },
  clearBtnText: { fontSize: 13, fontWeight: '600', color: Colors.error },
  addForm: { margin: Space.lg, gap: Space.sm },
  addTitle: { fontSize: 16, fontWeight: '700', color: Colors.text },
  input: { backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 14 },
  multiInput: { minHeight: 60, textAlignVertical: 'top' },
  addFormBtns: { flexDirection: 'row', gap: Space.sm },
  explainer: { margin: Space.lg, gap: Space.sm },
  explainerTitle: { fontSize: 15, fontWeight: '700', color: Colors.text },
  explainerText: { fontSize: 13, color: Colors.textSecondary, lineHeight: 20 },
  code: { fontFamily: 'monospace', color: Colors.accent, fontSize: 12 },
  list: { padding: Space.lg, gap: Space.sm },
  memCard: { padding: Space.md },
  memRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  memInfo: { flex: 1, gap: 4 },
  memKey: { fontSize: 13, fontWeight: '700', color: Colors.accent, fontFamily: 'monospace' },
  memValue: { fontSize: 14, color: Colors.text, lineHeight: 20 },
  memDate: { fontSize: 11, color: Colors.textMuted },
  deleteBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  deleteBtnText: { fontSize: 14 },
})
