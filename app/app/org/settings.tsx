import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert, Switch } from 'react-native'
import { useState, useCallback } from 'react'
import { useRouter, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'

export default function OrgSettingsScreen() {
  const router = useRouter()
  const { currentOrg, departments, setCurrentOrg, setDepartments } = useStore()
  const [name, setName] = useState(currentOrg?.name ?? '')
  const [description, setDescription] = useState(currentOrg?.description ?? '')
  const [newDept, setNewDept] = useState('')
  const [saving, setSaving] = useState(false)
  const [addingDept, setAddingDept] = useState(false)
  const [showTelegramSetup, setShowTelegramSetup] = useState(false)
  const [telegramToken, setTelegramToken] = useState('')

  const loadDepts = useCallback(async () => {
    if (!currentOrg) return
    const { departments: list } = await api.orgs.departments.list(currentOrg.id)
    setDepartments(list)
  }, [currentOrg])

  const handleSave = async () => {
    if (!currentOrg || !name.trim()) return
    setSaving(true)
    try {
      await api.orgs.update(currentOrg.id, { name: name.trim(), description: description || undefined })
      setCurrentOrg({ ...currentOrg, name: name.trim(), description })
      Alert.alert('Saved', 'Organisation updated')
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setSaving(false) }
  }

  const handleAddDept = async () => {
    if (!newDept.trim() || !currentOrg) return
    setAddingDept(true)
    try {
      const { department } = await api.orgs.departments.create(currentOrg.id, newDept.trim())
      setDepartments([...departments, department])
      setNewDept('')
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setAddingDept(false) }
  }

  const handleDeleteDept = (deptId: string, deptName: string) => {
    Alert.alert('Delete Department', `Delete "${deptName}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await api.orgs.departments.delete(currentOrg!.id, deptId)
        setDepartments(departments.filter(d => d.id !== deptId))
      }},
    ])
  }

  const handleTelegramSetup = async () => {
    if (!telegramToken.trim() || !currentOrg) return
    try {
      await api.comms.telegram.register(currentOrg.id, telegramToken.trim())
      Alert.alert('Connected', 'Telegram bot registered. Messages will appear in the Comms tab.')
      setShowTelegramSetup(false)
      setTelegramToken('')
    } catch (e: any) { Alert.alert('Error', e.message) }
  }

  if (!currentOrg) return null

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Org Settings' }} />

      {/* Organisation details */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Organisation</Text>
        <View style={styles.field}><Text style={styles.label}>Name</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor={Colors.textMuted} /></View>
        <View style={styles.field}><Text style={styles.label}>Description</Text>
          <TextInput style={[styles.input, styles.multi]} value={description} onChangeText={setDescription} placeholder="What does this org do?" placeholderTextColor={Colors.textMuted} multiline /></View>
        <Button label="Save" onPress={handleSave} loading={saving} />
      </View>

      {/* Departments */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Departments</Text>
        {departments.map(d => (
          <Card key={d.id} style={styles.deptRow}>
            <Text style={styles.deptName}>🏢 {d.name}</Text>
            <TouchableOpacity onPress={() => handleDeleteDept(d.id, d.name)}><Text style={styles.deleteText}>Remove</Text></TouchableOpacity>
          </Card>
        ))}
        <View style={styles.addDeptRow}>
          <TextInput style={[styles.input, styles.deptInput]} value={newDept} onChangeText={setNewDept} placeholder="New department name" placeholderTextColor={Colors.textMuted} />
          <Button label={addingDept ? '...' : 'Add'} onPress={handleAddDept} loading={addingDept} disabled={!newDept.trim()} style={styles.addBtn} />
        </View>
      </View>

      {/* Integrations */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Integrations</Text>
        <Card style={styles.integrationCard}>
          <View style={styles.integrationRow}>
            <Text style={styles.integrationIcon}>✈️</Text>
            <View style={styles.integrationInfo}>
              <Text style={styles.integrationName}>Telegram Bot</Text>
              <Text style={styles.integrationSub}>Route messages through a Telegram bot</Text>
            </View>
            <TouchableOpacity onPress={() => setShowTelegramSetup(!showTelegramSetup)}>
              <Text style={styles.setupLink}>{showTelegramSetup ? 'Cancel' : 'Setup'}</Text>
            </TouchableOpacity>
          </View>
          {showTelegramSetup && (
            <View style={styles.setupBox}>
              <Text style={styles.label}>Bot Token</Text>
              <TextInput style={styles.input} value={telegramToken} onChangeText={setTelegramToken} placeholder="1234567890:ABCdef..." placeholderTextColor={Colors.textMuted} secureTextEntry />
              <Button label="Connect" onPress={handleTelegramSetup} disabled={!telegramToken.trim()} />
            </View>
          )}
        </Card>
        <Card style={styles.integrationCard}>
          <View style={styles.integrationRow}>
            <Text style={styles.integrationIcon}>📧</Text>
            <View style={styles.integrationInfo}>
              <Text style={styles.integrationName}>Gmail</Text>
              <Text style={styles.integrationSub}>Connect via Google OAuth in the Knowledge tab</Text>
            </View>
            <Text style={styles.statusTag}>Via OAuth</Text>
          </View>
        </Card>
        <Card style={styles.integrationCard}>
          <View style={styles.integrationRow}>
            <Text style={styles.integrationIcon}>💻</Text>
            <View style={styles.integrationInfo}>
              <Text style={styles.integrationName}>Google Drive</Text>
              <Text style={styles.integrationSub}>Files available in Knowledge tab</Text>
            </View>
            <Text style={styles.statusTag}>Via OAuth</Text>
          </View>
        </Card>
      </View>

      {/* Danger zone */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: Colors.error }]}>Danger Zone</Text>
        <Button label="Delete Organisation" onPress={() => Alert.alert('Not yet', 'Delete org from web dashboard')} variant="danger" />
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.xl, paddingBottom: 48 },
  section: { gap: Space.sm },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  field: { gap: Space.xs },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  multi: { minHeight: 60, textAlignVertical: 'top' },
  deptRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Space.md },
  deptName: { fontSize: 14, color: Colors.text, fontWeight: '500' },
  deleteText: { fontSize: 13, color: Colors.error },
  addDeptRow: { flexDirection: 'row', gap: Space.sm },
  deptInput: { flex: 1 },
  addBtn: { paddingHorizontal: Space.lg },
  integrationCard: { padding: Space.md, gap: Space.sm },
  integrationRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  integrationIcon: { fontSize: 24, width: 36, textAlign: 'center' },
  integrationInfo: { flex: 1 },
  integrationName: { fontSize: 15, fontWeight: '600', color: Colors.text },
  integrationSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  setupLink: { fontSize: 13, color: Colors.accent, fontWeight: '600' },
  statusTag: { fontSize: 12, color: Colors.textMuted, backgroundColor: Colors.surfaceHigh, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  setupBox: { gap: Space.sm, paddingTop: Space.sm, borderTopWidth: 1, borderTopColor: Colors.border },
})
