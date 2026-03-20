import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../../store'
import { api, CostData } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { AgentAvatar } from '../../components/AgentAvatar'
import { EmptyState } from '../../components/EmptyState'

const PERIODS = ['7d', '30d', '90d']
const GROUPS = ['agent', 'day']

export default function CostsScreen() {
  const { currentOrg, agents } = useStore()
  const [period, setPeriod] = useState('30d')
  const [groupBy, setGroupBy] = useState<'agent' | 'day'>('agent')
  const [costs, setCosts] = useState<CostData[]>([])
  const [totals, setTotals] = useState<any>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const data = await api.costs.get(currentOrg.id, groupBy, period)
      setCosts(Array.isArray(data.costs) ? data.costs : [])
      setTotals(data.totals)
    } catch (e) { console.error(e) }
  }, [currentOrg, period, groupBy])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const agentMap = new Map(agents.map(a => [a.id, a]))
  const maxCost = Math.max(...costs.map(c => c.totalCost), 0.0001)

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
    >
      {/* Period selector */}
      <View style={styles.row}>
        {PERIODS.map(p => (
          <TouchableOpacity key={p} style={[styles.chip, period === p && styles.chipActive]} onPress={() => setPeriod(p)}>
            <Text style={[styles.chipText, period === p && styles.chipTextActive]}>{p}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        {GROUPS.map(g => (
          <TouchableOpacity key={g} style={[styles.chip, groupBy === g && styles.chipActive]} onPress={() => setGroupBy(g as any)}>
            <Text style={[styles.chipText, groupBy === g && styles.chipTextActive]}>{g === 'agent' ? 'By Agent' : 'By Day'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Summary cards */}
      {totals && (
        <View style={styles.statsRow}>
          <Card style={styles.statCard}>
            <Text style={styles.statVal}>${(totals.totalCost ?? 0).toFixed(4)}</Text>
            <Text style={styles.statLabel}>Total Cost</Text>
          </Card>
          <Card style={styles.statCard}>
            <Text style={styles.statVal}>{((totals.totalTokens ?? 0) / 1000).toFixed(1)}K</Text>
            <Text style={styles.statLabel}>Tokens</Text>
          </Card>
          <Card style={styles.statCard}>
            <Text style={styles.statVal}>{totals.taskCount ?? 0}</Text>
            <Text style={styles.statLabel}>Tasks</Text>
          </Card>
        </View>
      )}

      {/* Cost breakdown */}
      {costs.length === 0 ? (
        <EmptyState emoji="💸" title="No cost data" subtitle="Costs appear here once agents start working" />
      ) : (
        <View style={styles.barSection}>
          {costs.map((item, i) => {
            const agent = item.agentId ? agentMap.get(item.agentId) : null
            const pct = item.totalCost / maxCost
            const label = item.agentName ?? item.date ?? 'Unknown'
            return (
              <View key={i} style={styles.barRow}>
                <View style={styles.barLabel}>
                  {agent ? <AgentAvatar emoji={agent.avatarEmoji} size={28} /> : <Text style={styles.dateLabel}>{label.slice(5)}</Text>}
                  <Text style={styles.barName} numberOfLines={1}>{label}</Text>
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${Math.max(pct * 100, 2)}%` }]} />
                </View>
                <Text style={styles.barCost}>${item.totalCost.toFixed(4)}</Text>
              </View>
            )
          })}
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg },
  row: { flexDirection: 'row', gap: Space.xs, flexWrap: 'wrap' },
  chip: { paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.xl, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.accentDim, borderColor: Colors.accent },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.accent, fontWeight: '700' },
  statsRow: { flexDirection: 'row', gap: Space.sm },
  statCard: { flex: 1, alignItems: 'center', padding: Space.md },
  statVal: { fontSize: 18, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  barSection: { gap: Space.sm },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  barLabel: { width: 100, flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  dateLabel: { fontSize: 12, color: Colors.textSecondary, width: 28, textAlign: 'center' },
  barName: { flex: 1, fontSize: 12, color: Colors.text, fontWeight: '500' },
  barTrack: { flex: 1, height: 8, backgroundColor: Colors.surfaceHigh, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: Colors.accent, borderRadius: 4 },
  barCost: { fontSize: 12, color: Colors.textSecondary, width: 60, textAlign: 'right' },
})
