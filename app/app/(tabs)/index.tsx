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
  const { currentOrg, orgs, agents, tasks, setOrgs, setCurrentOrg, setAgents, setTasks, departments, setDepartments } = useStore()
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const { orgs: orgList } = await api.orgs.list()
      setOrgs(orgList)
      if (orgList.length > 0) {
        const org = orgList[0]
        setCurrentOrg(org)
        const [{ agents: agentList }, { tasks: taskList }, { departments: deptList }] = await Promise.all([
          api.agents.list(org.id),
          api.tasks.list(org.id),
          api.orgs.departments.list(org.id),
        ])
        setAgents(agentList)
        setTasks(taskList)
        setDepartments(deptList)
      }
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { loadData() }, [])
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false) }

  const activeAgents = agents.filter(a => a.status === 'active')
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress')
  const doneTasks = tasks.filter(t => t.status === 'done')
  const totalCost = tasks.reduce((s, t) => s + (t.costUsd ?? 0), 0)

  if (!currentOrg) {
    return (
      <View style={styles.center}>
        <Text style={styles.emoji}>🏢</Text>
        <Text style={styles.emptyTitle}>No organisation yet</Text>
        <Text style={styles.emptySubtitle}>Create your first org to get started</Text>
        <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/org/create')}>
          <Text style={styles.createBtnText}>Create Organisation</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push('/onboarding')}>
          <Text style={styles.tourLink}>Take a tour first →</Text>
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
          <Text style={styles.orgSub}>{agents.length} agents · {departments.length} depts · {tasks.length} tasks</Text>
        </View>
        <View style={styles.orgActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/org-chart')}>
            <Text style={styles.iconBtnText}>📊</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/org/settings')}>
            <Text style={styles.iconBtnText}>⚙️</Text>
          </TouchableOpacity>
        </View>
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
          <Text style={[styles.statNum, { color: Colors.accent }]}>${totalCost.toFixed(3)}</Text>
          <Text style={styles.statLabel}>Spent</Text>
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
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {agents.slice(0, 8).map(agent => (
              <TouchableOpacity key={agent.id} style={styles.agentChip} onPress={() => router.push(`/agents/${agent.id}`)}>
                <AgentAvatar emoji={agent.avatarEmoji} size={40} status={agent.status} />
                <Text style={styles.agentChipName} numberOfLines={1}>{agent.name}</Text>
                <StatusBadge status={agent.status} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.agentChip, styles.addAgentChip]} onPress={() => router.push('/agents/create')}>
              <Text style={styles.addAgentIcon}>+</Text>
              <Text style={styles.agentChipName}>Add</Text>
            </TouchableOpacity>
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
          {tasks.slice(0, 4).map(task => (
            <Card key={task.id} style={styles.taskCard}>
              <View style={styles.taskRow}>
                <Text style={styles.taskTitle} numberOfLines={1}>{task.title}</Text>
                <StatusBadge status={task.status} />
              </View>
              {task.costUsd != null && (
                <Text style={styles.taskCost}>${task.costUsd.toFixed(5)} · {task.tokensUsed?.toLocaleString()} tok</Text>
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
            { label: '📊 Org Chart', path: '/org-chart' },
            { label: '📚 Knowledge', path: '/(tabs)/knowledge' },
            { label: '⚡ Skills', path: '/skills' },
            { label: '📬 Comms', path: '/(tabs)/comms' },
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
  emoji: { fontSize: 56 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: Colors.text },
  emptySubtitle: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  createBtn: { backgroundColor: Colors.accent, paddingHorizontal: Space.xl, paddingVertical: Space.md, borderRadius: Radius.md, marginTop: Space.md },
  createBtnText: { fontSize: 15, fontWeight: '700', color: '#000' },
  tourLink: { fontSize: 14, color: Colors.accent, marginTop: Space.sm },
  orgHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  orgName: { fontSize: 26, fontWeight: '800', color: Colors.text },
  orgSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  orgActions: { flexDirection: 'row', gap: Space.sm },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  iconBtnText: { fontSize: 16 },
  statsRow: { flexDirection: 'row', gap: Space.sm },
  statCard: { flex: 1, alignItems: 'center', padding: Space.md },
  statNum: { fontSize: 20, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  section: { gap: Space.sm },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.text },
  sectionLink: { fontSize: 13, color: Colors.accent },
  agentChip: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, alignItems: 'center', gap: Space.xs, marginRight: Space.sm, width: 88 },
  agentChipName: { fontSize: 11, color: Colors.text, fontWeight: '600', textAlign: 'center' },
  addAgentChip: { borderStyle: 'dashed', justifyContent: 'center' },
  addAgentIcon: { fontSize: 24, color: Colors.accent, fontWeight: '300' },
  taskCard: { padding: Space.md, gap: 4 },
  taskRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  taskTitle: { flex: 1, fontSize: 14, color: Colors.text, fontWeight: '500', marginRight: Space.sm },
  taskCost: { fontSize: 11, color: Colors.textMuted },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  quickBtn: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, paddingHorizontal: Space.md, paddingVertical: Space.sm },
  quickBtnText: { fontSize: 13, color: Colors.text, fontWeight: '500' },
})
