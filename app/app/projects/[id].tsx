import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api, Task } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { StatusBadge } from '../../components/StatusBadge'
import { PriorityBadge } from '../../components/PriorityBadge'
import { EmptyState } from '../../components/EmptyState'

const COLUMNS = ['todo', 'in_progress', 'blocked', 'done'] as const
const COLUMN_LABELS: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', blocked: '🛑 Blocked', done: '✅ Done' }

export default function ProjectBoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { currentOrg, agents, projects } = useStore()
  const project = projects.find(p => p.id === id)
  const [board, setBoard] = useState<Record<string, Task[]>>({ todo: [], in_progress: [], blocked: [], done: [] })
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    const { board: b } = await api.projects.board(id)
    setBoard(b)
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const moveTask = async (taskId: string, column: string) => {
    await api.tasks.move(taskId, column)
    load()
  }

  const agentMap = new Map(agents.map(a => [a.id, a]))

  if (!project) return null

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: project.name }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.boardScroll}>
        <View style={styles.boardRow}>
          {COLUMNS.map(col => (
            <View key={col} style={styles.column}>
              <View style={styles.colHeader}>
                <Text style={styles.colTitle}>{COLUMN_LABELS[col]}</Text>
                <View style={styles.colCount}><Text style={styles.colCountText}>{board[col]?.length ?? 0}</Text></View>
              </View>
              <ScrollView style={styles.colScroll} nestedScrollEnabled>
                {(board[col] ?? []).map(task => {
                  const agent = agentMap.get(task.agentId)
                  return (
                    <View key={task.id} style={styles.taskCard}>
                      <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
                      <View style={styles.taskMeta}>
                        {agent && <Text style={styles.agentTag}>{agent.avatarEmoji} {agent.name}</Text>}
                        <PriorityBadge priority={task.priority} />
                      </View>
                      <View style={styles.moveRow}>
                        {COLUMNS.filter(c => c !== col).map(c => (
                          <TouchableOpacity key={c} style={styles.moveBtn} onPress={() => moveTask(task.id, c)}>
                            <Text style={styles.moveBtnText}>→ {c.replace('_', ' ')}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )
                })}
                {(board[col] ?? []).length === 0 && (
                  <Text style={styles.emptyCol}>Empty</Text>
                )}
              </ScrollView>
            </View>
          ))}
        </View>
      </ScrollView>
      <TouchableOpacity style={styles.fab} onPress={() => router.push(`/tasks/create?projectId=${id}`)}>
        <Text style={styles.fabText}>+ Task</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  boardScroll: { flex: 1 },
  boardRow: { flexDirection: 'row', padding: Space.md, gap: Space.md, minHeight: '100%' },
  column: { width: 240, backgroundColor: Colors.surface, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden' },
  colHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  colTitle: { fontSize: 13, fontWeight: '700', color: Colors.text, textTransform: 'uppercase', letterSpacing: 0.5 },
  colCount: { backgroundColor: Colors.surfaceHigh, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  colCountText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  colScroll: { maxHeight: 600, padding: Space.sm },
  taskCard: { backgroundColor: Colors.surfaceHigh, borderRadius: Radius.md, padding: Space.md, marginBottom: Space.sm, borderWidth: 1, borderColor: Colors.border, gap: Space.xs },
  taskTitle: { fontSize: 13, fontWeight: '600', color: Colors.text, lineHeight: 18 },
  taskMeta: { flexDirection: 'row', gap: Space.xs, alignItems: 'center', flexWrap: 'wrap' },
  agentTag: { fontSize: 11, color: Colors.textSecondary },
  moveRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  moveBtn: { backgroundColor: Colors.surface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: Colors.border },
  moveBtnText: { fontSize: 10, color: Colors.textSecondary, textTransform: 'capitalize' },
  emptyCol: { fontSize: 12, color: Colors.textMuted, textAlign: 'center', padding: Space.lg },
  fab: { position: 'absolute', bottom: 24, right: 24, backgroundColor: Colors.accent, paddingHorizontal: Space.xl, paddingVertical: Space.md, borderRadius: Radius.xl },
  fabText: { fontSize: 15, fontWeight: '700', color: '#000' },
})
