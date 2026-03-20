import { View, Text, FlatList, StyleSheet, TouchableOpacity, Alert, RefreshControl } from 'react-native'
import { useEffect, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Button } from '../../components/Button'
import { useState } from 'react'

export default function ProjectsScreen() {
  const router = useRouter()
  const { currentOrg, projects, setProjects, tasks } = useStore()
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    const { projects: list } = await api.projects.list(currentOrg.id)
    setProjects(list)
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const handleDelete = (id: string, name: string) => {
    Alert.alert('Delete Project', `Delete "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await api.projects.delete(id); load() } },
    ])
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Projects</Text>
        <Button label="+ New" onPress={() => router.push('/projects/create')} variant="secondary" />
      </View>
      <FlatList
        data={projects}
        keyExtractor={p => p.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent=<EmptyState emoji="💼" title="No projects yet" subtitle="Create a project to start organising work" />
        renderItem={({ item: project }) => {
          const projectTasks = tasks.filter(t => t.projectId === project.id)
          const done = projectTasks.filter(t => t.status === 'done').length
          return (
            <TouchableOpacity onPress={() => router.push(`/projects/${project.id}`)}>
              <Card style={styles.projectCard}>
                <View style={styles.projectRow}>
                  <View style={styles.projectInfo}>
                    <Text style={styles.projectName}>{project.name}</Text>
                    {project.description && <Text style={styles.projectDesc} numberOfLines={2}>{project.description}</Text>}
                  </View>
                  <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(project.id, project.name)}>
                    <Text style={{ fontSize: 16 }}>🗑️</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.projectMeta}>
                  <Text style={styles.taskCount}>{projectTasks.length} tasks</Text>
                  {projectTasks.length > 0 && <Text style={styles.doneCount}>{done} done</Text>}
                  <Text style={styles.viewBoard}>View Board →</Text>
                </View>
              </Card>
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg },
  title: { fontSize: 22, fontWeight: '800', color: Colors.text },
  list: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.sm },
  projectCard: { gap: Space.sm },
  projectRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  projectInfo: { flex: 1 },
  projectName: { fontSize: 16, fontWeight: '700', color: Colors.text },
  projectDesc: { fontSize: 13, color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },
  deleteBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  projectMeta: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingTop: Space.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  taskCount: { fontSize: 12, color: Colors.textSecondary },
  doneCount: { fontSize: 12, color: Colors.success },
  viewBoard: { marginLeft: 'auto', fontSize: 12, color: Colors.accent, fontWeight: '600' },
})
