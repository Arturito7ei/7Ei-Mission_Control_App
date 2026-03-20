import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../../store'
import { api, Task } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { StatusBadge } from '../../components/StatusBadge'
import { PriorityBadge } from '../../components/PriorityBadge'
import { EmptyState } from '../../components/EmptyState'

const FILTERS = ['all', 'pending', 'in_progress', 'done', 'blocked']

export default function TasksScreen() {
  const { currentOrg, tasks, setTasks, agents } = useStore()
  const [filter, setFilter] = useState('all')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    const { tasks: list } = await api.tasks.list(currentOrg.id)
    setTasks(list)
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)
  const agentMap = new Map(agents.map(a => [a.id, a]))

  return (
    <View style={styles.container}>
      {/* Filter chips */}
      <View style={styles.filterRow}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.chip, filter === f && styles.chipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
              {f === 'all' ? 'All' : f.replace('_', ' ')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={t => t.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={<EmptyState emoji="📋" title="No tasks" subtitle="Tasks appear here as agents work" />}
        renderItem={({ item: task }) => {
          const agent = agentMap.get(task.agentId)
          return (
            <Card style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
                <StatusBadge status={task.status} />
              </View>
              <View style={styles.cardMeta}>
                {agent && (
                  <View style={styles.agentTag}>
                    <Text style={styles.agentEmoji}>{agent.avatarEmoji}</Text>
                    <Text style={styles.agentName}>{agent.name}</Text>
                  </View>
                )}
                <PriorityBadge priority={task.priority} />
              </View>
              {task.output && (
                <Text style={styles.output} numberOfLines={2}>{task.output}</Text>
              )}
              {task.costUsd != null && (
                <Text style={styles.cost}>
                  ${task.costUsd.toFixed(5)} · {task.tokensUsed?.toLocaleString()} tokens
                  {task.durationMs && ` · ${(task.durationMs / 1000).toFixed(1)}s`}
                </Text>
              )}
            </Card>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  filterRow: { flexDirection: 'row', paddingHorizontal: Space.lg, paddingVertical: Space.sm, gap: Space.xs },
  chip: { paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.xl, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.accentDim, borderColor: Colors.accent },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500', textTransform: 'capitalize' },
  chipTextActive: { color: Colors.accent, fontWeight: '700' },
  list: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.sm },
  card: { gap: Space.sm },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: Space.sm },
  taskTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text, lineHeight: 20 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  agentTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  agentEmoji: { fontSize: 14 },
  agentName: { fontSize: 12, color: Colors.textSecondary },
  output: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  cost: { fontSize: 11, color: Colors.textMuted },
})
