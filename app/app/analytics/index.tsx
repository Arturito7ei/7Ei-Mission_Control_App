import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { Stack } from 'expo-router'
import { useStore } from '../../store'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { AgentAvatar } from '../../components/AgentAvatar'
import { ThemedText } from '../../components/ThemedText'
import { Skeleton } from '../../components/Skeleton'

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'https://7ei-backend.fly.dev'

export default function AnalyticsScreen() {
  const { currentOrg, agents, tasks } = useStore()
  const { theme } = useTheme()
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d')
  const [stats, setStats] = useState<any>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const [costRes, usageRes] = await Promise.all([
        fetch(`${BASE}/api/orgs/${currentOrg.id}/costs?groupBy=agent&period=${period}`),
        fetch(`${BASE}/api/orgs/${currentOrg.id}/usage`),
      ])
      const [costData, usageData] = await Promise.all([costRes.json(), usageRes.json()])

      // Compute local stats from task store
      const periodMs = { '7d': 7, '30d': 30, '90d': 90 }[period] * 86400000
      const cutoff = Date.now() - periodMs
      const periodTasks = tasks.filter(t => new Date(t.createdAt).getTime() > cutoff)
      const doneTasks = periodTasks.filter(t => t.status === 'done')
      const failedTasks = periodTasks.filter(t => t.status === 'failed')
      const completionRate = periodTasks.length > 0 ? Math.round((doneTasks.length / periodTasks.length) * 100) : 0
      const avgDuration = doneTasks.length > 0
        ? Math.round(doneTasks.reduce((s, t) => s + (t.durationMs ?? 0), 0) / doneTasks.length / 1000)
        : 0
      const totalTokens = periodTasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0)
      const totalCost = periodTasks.reduce((s, t) => s + (t.costUsd ?? 0), 0)

      // Per-agent stats
      const agentMap = new Map(agents.map(a => [a.id, a]))
      const agentStats: Record<string, any> = {}
      for (const t of periodTasks) {
        if (!agentStats[t.agentId]) agentStats[t.agentId] = { done: 0, failed: 0, total: 0, cost: 0, tokens: 0 }
        agentStats[t.agentId].total++
        if (t.status === 'done') agentStats[t.agentId].done++
        if (t.status === 'failed') agentStats[t.agentId].failed++
        agentStats[t.agentId].cost += t.costUsd ?? 0
        agentStats[t.agentId].tokens += t.tokensUsed ?? 0
      }

      const leaderboard = Object.entries(agentStats)
        .map(([id, s]: any) => ({ id, agent: agentMap.get(id), ...s }))
        .sort((a, b) => b.done - a.done)

      setStats({ completionRate, avgDuration, totalTokens, totalCost, doneTasks: doneTasks.length, failedTasks: failedTasks.length, total: periodTasks.length, leaderboard, usage: usageData.usage })
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [currentOrg, period, tasks, agents])

  useEffect(() => { setLoading(true); load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.bg }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    >
      <Stack.Screen options={{ title: 'Analytics' }} />

      {/* Period selector */}
      <View style={styles.periodRow}>
        {(['7d', '30d', '90d'] as const).map(p => (
          <TouchableOpacity
            key={p}
            style={[styles.periodBtn, { backgroundColor: period === p ? theme.accentDim : theme.surface, borderColor: period === p ? theme.accent : theme.borderLight }]}
            onPress={() => setPeriod(p)}
          >
            <ThemedText variant="muted" style={{ fontSize: FontSize.sm, color: period === p ? theme.accent : undefined, fontWeight: period === p ? FontWeight.semibold : FontWeight.regular }}>{p}</ThemedText>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={{ gap: Space.sm }}>
          {[1,2,3,4].map(i => <Skeleton key={i} height={80} radius={Radius.lg} />)}
        </View>
      ) : stats ? (
        <>
          {/* Summary grid */}
          <View style={styles.grid}>
            {[
              { label: 'Tasks run',       value: stats.total,           color: theme.text },
              { label: 'Done',            value: stats.doneTasks,       color: theme.statusDone },
              { label: 'Completion',      value: `${stats.completionRate}%`, color: stats.completionRate >= 80 ? theme.statusDone : theme.statusWarning },
              { label: 'Avg duration',    value: `${stats.avgDuration}s`, color: theme.text },
              { label: 'Tokens used',     value: `${(stats.totalTokens/1000).toFixed(1)}K`, color: theme.textSecondary },
              { label: 'Total cost',      value: `$${stats.totalCost.toFixed(4)}`, color: theme.accent },
            ].map(s => (
              <Card key={s.label} style={styles.statCard}>
                <ThemedText style={{ fontSize: FontSize.xxl, fontWeight: FontWeight.heavy, color: s.color, letterSpacing: -0.5 }}>{s.value}</ThemedText>
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs, marginTop: 2 }}>{s.label}</ThemedText>
              </Card>
            ))}
          </View>

          {/* Failed tasks warning */}
          {stats.failedTasks > 0 && (
            <Card variant="error">
              <ThemedText variant="body">⚠ {stats.failedTasks} task{stats.failedTasks !== 1 ? 's' : ''} failed in this period</ThemedText>
            </Card>
          )}

          {/* Agent leaderboard */}
          {stats.leaderboard.length > 0 && (
            <View style={styles.section}>
              <ThemedText variant="label" style={{ marginBottom: Space.sm }}>Agent Leaderboard</ThemedText>
              {stats.leaderboard.map((row: any, i: number) => row.agent ? (
                <Card key={row.id} style={styles.leaderRow}>
                  <ThemedText variant="muted" style={{ fontSize: FontSize.lg, fontWeight: FontWeight.bold, width: 24 }}>{i + 1}</ThemedText>
                  <AgentAvatar emoji={row.agent.avatarEmoji} size={36} />
                  <View style={{ flex: 1 }}>
                    <ThemedText variant="body" style={{ fontWeight: FontWeight.semibold }}>{row.agent.name}</ThemedText>
                    <ThemedText variant="muted" style={{ fontSize: FontSize.xs }}>
                      {row.done} done · {row.failed} failed · ${row.cost.toFixed(4)}
                    </ThemedText>
                  </View>
                  {/* Mini progress bar: done / total */}
                  <View style={styles.miniBar}>
                    <View style={[styles.miniBarFill, { width: `${row.total > 0 ? (row.done / row.total) * 100 : 0}%`, backgroundColor: theme.accent }]} />
                  </View>
                </Card>
              ) : null)}
            </View>
          )}

          {/* Rate limit status */}
          {stats.usage && (
            <View style={styles.section}>
              <ThemedText variant="label" style={{ marginBottom: Space.sm }}>Today's Usage</ThemedText>
              <Card>
                {[
                  { label: 'Tokens', value: stats.usage.tokensToday, max: stats.usage.limits.tokensPerDay ?? 500000, fmt: (v: number) => `${(v/1000).toFixed(1)}K` },
                  { label: 'Cost', value: stats.usage.costToday, max: stats.usage.limits.costPerDay ?? 5, fmt: (v: number) => `$${v.toFixed(4)}` },
                ].map(u => {
                  const pct = u.max > 0 ? Math.min((u.value / u.max) * 100, 100) : 0
                  return (
                    <View key={u.label} style={{ marginBottom: Space.md }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: Space.xs }}>
                        <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>{u.label}</ThemedText>
                        <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>{u.fmt(u.value)} / {u.fmt(u.max)}</ThemedText>
                      </View>
                      <View style={[styles.track, { backgroundColor: theme.surfaceHigh }]}>
                        <View style={[styles.fill, { width: `${pct}%` as any, backgroundColor: pct > 80 ? theme.statusError : theme.accent }]} />
                      </View>
                    </View>
                  )
                })}
              </Card>
            </View>
          )}
        </>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Space.lg, gap: Space.lg, paddingBottom: 48 },
  periodRow: { flexDirection: 'row', gap: Space.sm },
  periodBtn: { flex: 1, paddingVertical: Space.sm, borderRadius: Radius.md, borderWidth: 0.5, alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  statCard: { width: '48%', alignItems: 'flex-start', paddingVertical: Space.md },
  section: {},
  leaderRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, padding: Space.md, marginBottom: Space.xs },
  miniBar: { width: 48, height: 6, backgroundColor: '#222', borderRadius: 3, overflow: 'hidden' },
  miniBarFill: { height: '100%', borderRadius: 3 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
})
