import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native'
import { useStore } from '../../store'
import { Colors, Space, Radius } from '../../constants/colors'
import { AgentAvatar } from '../../components/AgentAvatar'
import { StatusBadge } from '../../components/StatusBadge'
import { useRouter } from 'expo-router'

export default function OrgChartScreen() {
  const { currentOrg, agents, departments } = useStore()
  const router = useRouter()

  if (!currentOrg) return null

  // Group agents by department
  const noDept = agents.filter(a => !a.departmentId)
  const byDept = departments.map(d => ({
    dept: d,
    agents: agents.filter(a => a.departmentId === d.id),
  }))

  // Find orchestrator (arturito / first agent)
  const orchestrator = agents.find(a => a.role.toLowerCase().includes('orchestrator') || a.role.toLowerCase().includes('chief')) ?? agents[0]
  const others = orchestrator ? agents.filter(a => a.id !== orchestrator.id) : agents

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.orgName}>{currentOrg.name}</Text>

      {/* Orchestrator at top */}
      {orchestrator && (
        <View style={styles.orchLevel}>
          <TouchableOpacity style={styles.orchCard} onPress={() => router.push(`/agents/${orchestrator.id}`)}>
            <AgentAvatar emoji={orchestrator.avatarEmoji} size={56} status={orchestrator.status} />
            <Text style={styles.orchName}>{orchestrator.name}</Text>
            <Text style={styles.orchRole} numberOfLines={1}>{orchestrator.role}</Text>
            <StatusBadge status={orchestrator.status} />
          </TouchableOpacity>
        </View>
      )}

      {/* Connector line */}
      {orchestrator && others.length > 0 && (
        <View style={styles.connector}>
          <View style={styles.connectorLine} />
        </View>
      )}

      {/* Departments */}
      {byDept.filter(d => d.agents.length > 0).map(({ dept, agents: deptAgents }) => (
        <View key={dept.id} style={styles.deptSection}>
          <View style={styles.deptHeader}>
            <Text style={styles.deptName}>{dept.name}</Text>
          </View>
          <View style={styles.agentRow}>
            {deptAgents.map(agent => (
              <TouchableOpacity key={agent.id} style={styles.agentCard} onPress={() => router.push(`/agents/${agent.id}`)}>
                <AgentAvatar emoji={agent.avatarEmoji} size={44} status={agent.status} />
                <Text style={styles.agentName} numberOfLines={1}>{agent.name}</Text>
                <Text style={styles.agentRole} numberOfLines={1}>{agent.role.split(' ').slice(0, 2).join(' ')}</Text>
                <StatusBadge status={agent.status} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}

      {/* Undepartmented agents */}
      {noDept.filter(a => a.id !== orchestrator?.id).length > 0 && (
        <View style={styles.deptSection}>
          <View style={styles.deptHeader}>
            <Text style={styles.deptName}>General</Text>
          </View>
          <View style={styles.agentRow}>
            {noDept.filter(a => a.id !== orchestrator?.id).map(agent => (
              <TouchableOpacity key={agent.id} style={styles.agentCard} onPress={() => router.push(`/agents/${agent.id}`)}>
                <AgentAvatar emoji={agent.avatarEmoji} size={44} status={agent.status} />
                <Text style={styles.agentName} numberOfLines={1}>{agent.name}</Text>
                <Text style={styles.agentRole} numberOfLines={1}>{agent.role.split(' ').slice(0, 2).join(' ')}</Text>
                <StatusBadge status={agent.status} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Silver Board */}
      {agents.filter(a => a.agentType === 'advisor').length > 0 && (
        <View style={styles.advisorSection}>
          <Text style={styles.advisorTitle}>🎖️ Silver Board</Text>
          <View style={styles.agentRow}>
            {agents.filter(a => a.agentType === 'advisor').map(agent => (
              <TouchableOpacity key={agent.id} style={[styles.agentCard, styles.advisorCard]} onPress={() => router.push(`/agents/${agent.id}`)}>
                <AgentAvatar emoji={agent.avatarEmoji} size={44} status={agent.status} />
                <Text style={styles.agentName} numberOfLines={1}>{agent.name}</Text>
                {agent.advisorPersona && <Text style={styles.personaTag} numberOfLines={1}>{agent.advisorPersona.slice(0, 24)}</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg, alignItems: 'center' },
  orgName: { fontSize: 22, fontWeight: '800', color: Colors.text, marginBottom: Space.sm },
  orchLevel: { alignItems: 'center' },
  orchCard: { backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.accent, borderRadius: Radius.lg, padding: Space.lg, alignItems: 'center', gap: Space.sm, width: 160 },
  orchName: { fontSize: 15, fontWeight: '700', color: Colors.text },
  orchRole: { fontSize: 12, color: Colors.textSecondary, textAlign: 'center' },
  connector: { alignItems: 'center', height: 32 },
  connectorLine: { width: 2, flex: 1, backgroundColor: Colors.border },
  deptSection: { width: '100%', gap: Space.sm },
  deptHeader: { borderLeftWidth: 3, borderLeftColor: Colors.accent, paddingLeft: Space.md },
  deptName: { fontSize: 14, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  agentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, justifyContent: 'center' },
  agentCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, alignItems: 'center', gap: Space.xs, width: 100 },
  agentName: { fontSize: 12, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  agentRole: { fontSize: 10, color: Colors.textSecondary, textAlign: 'center' },
  advisorSection: { width: '100%', gap: Space.sm, marginTop: Space.md },
  advisorTitle: { fontSize: 16, fontWeight: '700', color: Colors.accent, textAlign: 'center' },
  advisorCard: { borderColor: Colors.accent + '44', backgroundColor: Colors.accentDim },
  personaTag: { fontSize: 10, color: Colors.accent },
})
