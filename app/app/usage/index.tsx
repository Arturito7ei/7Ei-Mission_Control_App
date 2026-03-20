import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { Stack } from 'expo-router'
import { useStore } from '../../store'
import { api, UsageStats } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'

function ProgressBar({ value, max, color = Colors.accent }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: pct > 80 ? Colors.error : color }]} />
    </View>
  )
}

export default function UsageScreen() {
  const { currentOrg } = useStore()
  const [usage, setUsage] = useState<UsageStats | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try { const { usage: u } = await api.usage.get(currentOrg.id); setUsage(u) } catch {}
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  if (!usage) return null

  const STATS = [
    { label: 'Requests this minute', value: usage.requestsThisMinute, max: usage.limits.requestsPerMinute ?? 60, unit: `/ ${usage.limits.requestsPerMinute ?? 60} rpm` },
    { label: 'Tokens today', value: usage.tokensToday, max: usage.limits.tokensPerDay ?? 500000, unit: `/ ${((usage.limits.tokensPerDay ?? 500000) / 1000).toFixed(0)}K`, fmt: (v: number) => `${(v / 1000).toFixed(1)}K` },
    { label: 'Cost today', value: usage.costToday, max: usage.limits.costPerDay ?? 5, unit: `/ $${usage.limits.costPerDay ?? 5}`, fmt: (v: number) => `$${v.toFixed(4)}` },
    { label: 'Concurrent tasks', value: usage.concurrentTasks, max: usage.limits.concurrentTasks ?? 5, unit: `/ ${usage.limits.concurrentTasks ?? 5} slots` },
  ]

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}>
      <Stack.Screen options={{ title: 'Usage & Limits' }} />
      <Text style={styles.title}>Usage & Limits</Text>
      <Text style={styles.subtitle}>Current rate limits and daily budget status</Text>
      {STATS.map(stat => {
        const pct = stat.max > 0 ? (stat.value / stat.max) * 100 : 0
        const displayVal = stat.fmt ? stat.fmt(stat.value) : String(stat.value)
        const isHigh = pct > 80
        return (
          <Card key={stat.label} style={styles.statCard}>
            <View style={styles.statHeader}>
              <Text style={styles.statLabel}>{stat.label}</Text>
              <Text style={[styles.statValue, isHigh && { color: Colors.error }]}>{displayVal}</Text>
            </View>
            <ProgressBar value={stat.value} max={stat.max} />
            <Text style={styles.statUnit}>{stat.unit}</Text>
            {isHigh && <Text style={styles.warningText}>⚠️ Approaching limit</Text>}
          </Card>
        )
      })}
      <Card style={styles.infoCard}>
        <Text style={styles.infoTitle}>ℹ️ Configuring limits</Text>
        <Text style={styles.infoText}>Set these env vars on the backend to override defaults:{'
'}{'
'}
          <Text style={styles.envVar}>RATE_LIMIT_RPM</Text>{'  '}requests/min{'
'}
          <Text style={styles.envVar}>RATE_LIMIT_TOKENS_DAY</Text>{'  '}tokens/day{'
'}
          <Text style={styles.envVar}>RATE_LIMIT_COST_DAY</Text>{'  '}max USD/day{'
'}
          <Text style={styles.envVar}>RATE_LIMIT_CONCURRENT</Text>{'  '}parallel tasks
        </Text>
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg },
  title: { fontSize: 24, fontWeight: '800', color: Colors.text },
  subtitle: { fontSize: 14, color: Colors.textSecondary },
  statCard: { gap: Space.sm },
  statHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statLabel: { fontSize: 14, fontWeight: '600', color: Colors.text },
  statValue: { fontSize: 18, fontWeight: '700', color: Colors.accent },
  track: { height: 8, backgroundColor: Colors.surfaceHigh, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  statUnit: { fontSize: 12, color: Colors.textMuted },
  warningText: { fontSize: 12, color: Colors.error, fontWeight: '600' },
  infoCard: { gap: Space.sm },
  infoTitle: { fontSize: 15, fontWeight: '700', color: Colors.text },
  infoText: { fontSize: 13, color: Colors.textSecondary, lineHeight: 22 },
  envVar: { fontFamily: 'monospace', color: Colors.accent, fontSize: 12 },
})
