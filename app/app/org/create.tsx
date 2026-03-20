import { View, Text, ScrollView, StyleSheet, TextInput, Alert } from 'react-native'
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Button } from '../../components/Button'

export default function CreateOrgScreen() {
  const router = useRouter()
  const { setCurrentOrg, setOrgs, orgs } = useStore()
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const handleCreate = async () => {
    if (!name.trim()) { Alert.alert('Required', 'Organisation name is required'); return }
    setLoading(true)
    try {
      const { org } = await api.orgs.create({ name: name.trim(), description: description || undefined })
      setOrgs([...orgs, org])
      setCurrentOrg(org)
      router.replace('/(tabs)')
    } catch (e: any) {
      Alert.alert('Error', e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.heroEmoji}>🏢</Text>
        <Text style={styles.heroTitle}>Create your organisation</Text>
        <Text style={styles.heroSub}>Your virtual office starts here. Add agents, projects, and departments as you grow.</Text>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Organisation Name *</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. 7Ei, Acme Corp, My Startup" placeholderTextColor={Colors.textMuted} />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Description</Text>
        <TextInput style={[styles.input, styles.inputMulti]} value={description} onChangeText={setDescription} placeholder="What does this organisation do?" placeholderTextColor={Colors.textMuted} multiline />
      </View>
      <Button label="Create Organisation" onPress={handleCreate} loading={loading} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.xl, gap: Space.xl },
  hero: { alignItems: 'center', gap: Space.md, paddingVertical: Space.xl },
  heroEmoji: { fontSize: 56 },
  heroTitle: { fontSize: 24, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  heroSub: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  field: { gap: Space.xs },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
})
