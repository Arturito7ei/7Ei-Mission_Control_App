import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, RefreshControl, ActivityIndicator } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { StatusBadge } from '../../components/StatusBadge'
import { AgentAvatar } from '../../components/AgentAvatar'
import { EmptyState } from '../../components/EmptyState'

export default function AgentsScreen() {
  const router = useRouter()
  const { currentOrg, agents, setAgents, updateAgent } = useStore()
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const { agents: list } = await api.agents.list(currentOrg.id)
      setAgents(list)
    } finally { setLoading(false) }
  }, [currentOrg])

  useEffect(() => { load() }, [load])

  if (loading && agents.length === 0) {
    return <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator size="large" color={Colors.accent} /></View>
  }

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.role.toLowerCase().includes(search.toLowerCase())
  )
  const standardAgents = filtered.filter(a => a.agentType !== 'advisor')
  const advisorAgents = filtered.filter(a => a.agentType === 'advisor')
  const groupedData = [
    ...standardAgents,
    ...(advisorAgents.length > 0 ? [{ id: '__silver_board_header__', _isHeader: true } as any, ...advisorAgents] : []),
  ]

  const handleStatusToggle = async (agentId: string, current: string) => {
    const next = current === 'paused' ? 'idle' : current === 'idle' ? 'paused' : 'paused'
    await api.agents.setStatus(agentId, next)
    updateAgent(agentId, { status: next })
  }

  return (
    <View style={styles.container}>
      {/* Search + Add */}
      <View style={styles.header}>
        <TextInput
          style={styles.search}
          placeholder="Search agents..."
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        <TouchableOpacity style={styles.addBtn} onPress={() => router.push('/agents/create')}>
          <Text style={styles.addBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={groupedData}
        keyExtractor={a => a.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={
          <EmptyState emoji="🤖" title="No agents yet" subtitle="Create your first agent to start building your virtual office" />
        }
        renderItem={({ item: agent }) => {
          if (agent._isHeader) {
            return (
              <TouchableOpacity style={styles.sectionHeader} onPress={() => router.push('/agents/board')}>
                <Text style={styles.sectionTitle}>🎖️ Silver Board</Text>
                <Text style={styles.sectionLink}>View all →</Text>
              </TouchableOpacity>
            )
          }
          return (
          <TouchableOpacity onPress={() => router.push(`/agents/${agent.id}`)}>
            <Card style={styles.agentCard}>
              <View style={styles.agentRow}>
                <AgentAvatar emoji={agent.avatarEmoji} size={48} status={agent.status} />
                <View style={styles.agentInfo}>
                  <Text style={styles.agentName}>{agent.name}</Text>
                  <Text style={styles.agentRole} numberOfLines={1}>{agent.role}</Text>
                  <View style={styles.agentMeta}>
                    <StatusBadge status={agent.status} />
                    {agent.skills.length > 0 && (
                      <Text style={styles.skillCount}>{agent.skills.length} skills</Text>
                    )}
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.pauseBtn}
                  onPress={() => handleStatusToggle(agent.id, agent.status)}
                >
                  <Text style={styles.pauseBtnText}>{agent.status === 'paused' ? '▶️' : '⏸️'}</Text>
                </TouchableOpacity>
              </View>
              {agent.agentType === 'advisor' && agent.advisorPersona && (
                <Text style={styles.persona} numberOfLines={1}>🎖️ {agent.advisorPersona}</Text>
              )}
            </Card>
          </TouchableOpacity>
        )}}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', padding: Space.lg, gap: Space.sm },
  search: { flex: 1, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  addBtn: { backgroundColor: Colors.accent, paddingHorizontal: Space.lg, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { fontSize: 14, fontWeight: '700', color: '#000' },
  list: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.sm },
  agentCard: { padding: Space.md },
  agentRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  agentInfo: { flex: 1 },
  agentName: { fontSize: 16, fontWeight: '700', color: Colors.text },
  agentRole: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  agentMeta: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: Space.xs },
  skillCount: { fontSize: 11, color: Colors.textMuted },
  pauseBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.surfaceHigh, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  pauseBtnText: { fontSize: 16 },
  persona: { fontSize: 12, color: Colors.textSecondary, marginTop: Space.sm, paddingTop: Space.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Space.md, marginTop: Space.md },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.text },
  sectionLink: { fontSize: 13, color: Colors.accent, fontWeight: '600' },
})
