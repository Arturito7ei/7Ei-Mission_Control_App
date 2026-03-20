import { View, Text, ScrollView, StyleSheet, TextInput, Alert } from 'react-native'
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Button } from '../../components/Button'

export default function CreateProjectScreen() {
  const router = useRouter()
  const { currentOrg, projects, setProjects } = useStore()
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const handleCreate = async () => {
    if (!name.trim()) { Alert.alert('Required', 'Project name is required'); return }
    if (!currentOrg) return
    setLoading(true)
    try {
      const { project } = await api.projects.create(currentOrg.id, { name: name.trim(), description: description || undefined })
      setProjects([...projects, project])
      router.replace(`/projects/${project.id}`)
    } catch (e: any) {
      Alert.alert('Error', e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New Project</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Project Name *</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Mission Control v2" placeholderTextColor={Colors.textMuted} />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Description</Text>
        <TextInput style={[styles.input, styles.multi]} value={description} onChangeText={setDescription} placeholder="What is this project about?" placeholderTextColor={Colors.textMuted} multiline />
      </View>
      <Button label="Create Project" onPress={handleCreate} loading={loading} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.xl, gap: Space.xl },
  title: { fontSize: 24, fontWeight: '800', color: Colors.text },
  field: { gap: Space.xs },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  multi: { minHeight: 80, textAlignVertical: 'top' },
})
