import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { StatusBadge } from '../../components/StatusBadge'
import { AgentAvatar } from '../../components/AgentAvatar'

export default function HomeScreen() {
  const router = useRouter()
  const { currentOrg, orgs, agents, tasks, setOrgs, setCurrentOrg, setAgents, setTasks } = useStore()
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const { orgs: orgList } = await api.orgs.list()
      setOrgs(orgList)
      if (orgList.length > 0) {
        const org = orgList[0]
        setCurrentOrg(org)
        const [{ agents: agentList }, { tasks: taskList }] = await Promise.all([
          api.agents.list(org.id),
          api.tasks.list(org.id),
        ])
        setAgents(agentList)
        setTasks(taskList)
      }
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { loadData() }, [])

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false) }

  const activeAgents = agents.filter(a => a.status === 'active')
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress')
  const doneTasks = tasks.filter(t => t.status === 'done')

  if (!currentOrg) {
    return (
      <View style={styles.center}>
        <Text style={styles.emoji}>🏢</Text>
        <Text style={styles.emptyTitle}>No organisation yet</Text>
        <Text style={styles.emptySubtitle}>Create your first org to get started</Text>
        <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/org/create')}>
          <Text style={styles.createBtnText}>Create Organisation</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
    >
      {/* Org header */}
      <View style={styles.orgHeader}>
        <View>
          <Text style={styles.orgName}>{currentOrg.name}</Text>
          <Text style={styles.orgSub}>{agents.length} agents · {tasks.length} tasks</Text>
        </View>
        <TouchableOpacity style={styles.orgBtn} onPress={() => router.push('/org/settings')}>
          <Text style={styles.orgBtnText}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <Card style={styles.statCard}>
          <Text style={styles.statNum}>{agents.length}</Text>
          <Text style={styles.statLabel}>Agents</Text>
        </Card>
        <Card style={styles.statCard}>
          <Text style={[styles.statNum, { color: Colors.active }]}>{activeAgents.length}</Text>
          <Text style={styles.statLabel}>Active</Text>
        </Card>
        <Card style={styles.statCard}>
          <Text style={[styles.statNum, { color: Colors.warning }]}>{pendingTasks.length}</Text>
          <Text style={styles.statLabel}>In Progress</Text>
        </Card>
        <Card style={styles.statCard}>
          <Text style={[styles.statNum, { color: Colors.success }]}>{doneTasks.length}</Text>
          <Text style={styles.statLabel}>Done</Text>
        </Card>
      </View>

      {/* Agent squad */}
      {agents.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Agent Squad</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/agents')}>
              <Text style={styles.sectionLink}>See all →</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.agentScroll}>
            {agents.slice(0, 6).map(agent => (
              <TouchableOpacity key={agent.id} style={styles.agentChip} onPress={() => router.push(`/agents/${agent.id}`)}>
                <AgentAvatar emoji={agent.avatarEmoji} size={40} status={agent.status} />
                <Text style={styles.agentChipName} numberOfLines={1}>{agent.name}</Text>
                <StatusBadge status={agent.status} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Recent tasks */}
      {tasks.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Activity</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/tasks')}>
              <Text style={styles.sectionLink}>See all →</Text>
            </TouchableOpacity>
          </View>
          {tasks.slice(0, 5).map(task => (
            <Card key={task.id} style={styles.taskCard}>
              <View style={styles.taskRow}>
                <Text style={styles.taskTitle} numberOfLines={1}>{task.title}</Text>
                <StatusBadge status={task.status} />
              </View>
              {task.costUsd != null && (
                <Text style={styles.taskCost}>${task.costUsd.toFixed(4)} · {task.tokensUsed?.toLocaleString()} tokens</Text>
              )}
            </Card>
          ))}
        </View>
      )}

      {/* Quick actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.quickRow}>
          {[
            { label: '🤖 New Agent', path: '/agents/create' },
            { label: '💼 New Project', path: '/projects/create' },
            { label: '📚 Knowledge', path: '/(tabs)/knowledge' },
            { label: '📊 Costs', path: '/(tabs)/costs' },
          ].map(({ label, path }) => (
            <TouchableOpacity key={path} style={styles.quickBtn} onPress={() => router.push(path as any)}>
              <Text style={styles.quickBtnText}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg, padding: Space.xl, gap: Space.md },
  emoji: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: Colors.text },
  emptySubtitle: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  createBtn: { backgroundColor: Colors.accent, paddingHorizontal: Space.xl, paddingVertical: Space.md, borderRadius: Radius.md, marginTop: Space.md },
  createBtnText: { fontSize: 15, fontWeight: '700', color: '#000' },
  orgHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  orgName: { fontSize: 24, fontWeight: '800', color: Colors.text },
  orgSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  orgBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  orgBtnText: { fontSize: 16 },
  statsRow: { flexDirection: 'row', gap: Space.sm },
  statCard: { flex: 1, alignItems: 'center', padding: Space.md },
  statNum: { fontSize: 22, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  section: { gap: Space.sm },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.text },
  sectionLink: { fontSize: 13, color: Colors.accent },
  agentScroll: { marginHorizontal: -Space.lg, paddingHorizontal: Space.lg },
  agentChip: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, alignItems: 'center', gap: Space.xs, marginRight: Space.sm, width: 90 },
  agentChipName: { fontSize: 12, color: Colors.text, fontWeight: '600', textAlign: 'center' },
  taskCard: { padding: Space.md, gap: 4 },
  taskRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  taskTitle: { flex: 1, fontSize: 14, color: Colors.text, fontWeight: '500', marginRight: Space.sm },
  taskCost: { fontSize: 12, color: Colors.textMuted },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  quickBtn: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: Space.md, paddingVertical: Space.sm },
  quickBtnText: { fontSize: 13, color: Colors.text, fontWeight: '500' },
})
