// MOB-6b — the agent detail screen. Read-only, pushed from the Agents roster.
//
// MIRRORS the web's AgentDetail + its Dashboard tab
// (web/app/dashboard/agent/AgentDetail.tsx, DashboardTab.tsx) over the same two
// endpoints:
//
//   GET /api/agents/:agentId                        → identity + status + config
//   GET /api/orgs/:orgId/agents/:agentId/overview   → latest run, recent tasks,
//                                                     task distributions, costs
//
// WHAT IS DEFERRED, and why it's a deferral rather than a gap:
//   * The web's five other tabs (Instructions, Skills, Configuration, Runs,
//     Budget) — MOB-6b is the read view. Instructions/Configuration are the
//     agent's editable surface and Instructions is owner-gated markdown editing;
//     that is desk work, not phone work.
//   * The web's header ACTIONS (Assign Task, Run Heartbeat, Pause/Resume) —
//     writes. This story is read-only by scope, so the phone shows the state and
//     the desk changes it. Deferred to MOB-6b2 (see docs/DESIGN-mobile-parity.md).
//   * The web's four 14-day day-column charts. Run Activity and Success Rate are
//     68px of 14 unlabelled bars; at 390pt they'd be a smudge that reads as
//     decoration. The two DISTRIBUTIONS (by status, by priority) survive because
//     they're label + count + bar — they still read on a phone. This is the one
//     place the screen is deliberately not pixel-parity, and dropping a chart the
//     operator can't read is not the same as dropping the data: the same numbers
//     are on the Costs strip and the task rows.
//
// Colorblind-safe throughout: every status is a Chip (label + glyph), never hue
// alone — `status.ts` resolves both from the web's own table.

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  Api,
  type Agent,
  type AgentOverview,
  type AgentRecentTask,
} from '../api'
import { useAuth } from '../auth'
import { heartbeatIcon, heartbeatTone, statusIcon, statusTone } from '../status'
import { formatCost, formatTokens, NONE } from '../taskLog'
import { font, radius, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'

/** "8d ago" / "3h ago" / "just now" — the web's `ago`, ported from DashboardTab. */
export function ago(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null) return NONE
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

type Data = { overview: AgentOverview; recentTasks: AgentRecentTask[] }

export default function AgentDetailScreen({ agentId }: { agentId: string }) {
  const { apiUrl, getToken, orgId } = useAuth()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    setLoading(true)
    // Identity and overview are independent: a missing overview (a brand-new
    // agent, a 404 on the org-scoped route) must NOT blank out the identity the
    // operator navigated here to see. So they settle separately.
    const [a, o] = await Promise.allSettled([
      Api.agent(apiUrl, token, agentId),
      Api.agentOverview(apiUrl, token, orgId, agentId),
    ])
    if (a.status === 'fulfilled') setAgent(a.value)
    if (o.status === 'fulfilled') setData(o.value)
    if (a.status === 'rejected') {
      setError(a.reason?.message ?? 'Could not load this agent.')
    } else if (o.status === 'rejected') {
      setError(o.reason?.message ?? 'Could not load this agent’s activity.')
    }
    setLoading(false)
  }, [apiUrl, getToken, orgId, agentId])

  useEffect(() => {
    load()
  }, [load])

  if (loading && !agent && !data) return <Loading text="Loading agent…" />

  // Identity failed AND nothing else arrived — there is no screen to draw.
  if (!agent && !data) {
    return (
      <ScrollView contentContainerStyle={s.wrap}>
        <Banner kind="error">{error ?? 'Could not load this agent.'}</Banner>
      </ScrollView>
    )
  }

  const o = data?.overview
  const lr = o?.latestRun

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.blue} />}
    >
      {/* A partial failure is said out loud rather than shown as an empty
          section — "no runs" and "we couldn't fetch the runs" are different
          facts, and only one of them is the agent's fault. */}
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {/* ── Identity ───────────────────────────────────────────────────────── */}
      {agent ? (
        <Card style={{ marginBottom: space.lg }}>
          <View style={s.head}>
            <Text style={s.avatar}>{agent.avatarEmoji || '🤖'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{agent.name}</Text>
              {agent.role ? <Text style={s.role}>{agent.role}</Text> : null}
            </View>
          </View>
          <View style={s.tags}>
            <Chip
              label={(agent.status || 'unknown').toUpperCase()}
              tone={statusTone(agent.status)}
              glyph={statusIcon(agent.status)}
            />
            {/* A heartbeat is its own vocabulary (green/amber/stale) — it has to
                go through the heartbeat mapping, not the task-status table, or
                `green` and `amber` collapse onto 'idle' and a healthy agent
                looks exactly like one that never checked in. */}
            <Chip
              label={`heartbeat: ${agent.heartbeatStatus || 'unknown'}`}
              tone={heartbeatTone(agent.heartbeatStatus)}
              glyph={heartbeatIcon(agent.heartbeatStatus)}
            />
          </View>
        </Card>
      ) : null}

      {/* ── Key config ─────────────────────────────────────────────────────── */}
      {agent ? (
        <Section title="Configuration">
          <Card>
            <Row label="Runtime" value={agent.runtime ?? agent.agentType ?? NONE} />
            <Row
              label="Model"
              value={
                agent.llmModel
                  ? agent.llmProvider
                    ? `${agent.llmProvider} · ${agent.llmModel}`
                    : agent.llmModel
                  : NONE
              }
            />
            {/* Trust tier is a governance fact, so it keeps its own glyph rather
                than sitting in the row list as plain text. */}
            <View style={s.row}>
              <Text style={s.rowLabel}>Trust</Text>
              <Chip
                label={agent.trustMode === 'low_trust_review' ? 'low-trust review' : 'standard'}
                tone={agent.trustMode === 'low_trust_review' ? 'warn' : 'neutral'}
                glyph={agent.trustMode === 'low_trust_review' ? '⚠' : '•'}
              />
            </View>
          </Card>
          {/* Editing is desk work — say so, so a missing button reads as a
              decision rather than a bug. */}
          <Text style={s.note}>
            Read-only on the phone. Instructions, skills, and configuration are edited on the desk.
          </Text>
        </Section>
      ) : null}

      {/* ── Latest run ─────────────────────────────────────────────────────── */}
      {o ? (
        <Section title="Latest Run">
          <Card>
            {!lr ? (
              <Text style={s.empty}>This agent has not run yet.</Text>
            ) : (
              <View style={{ gap: space.sm }}>
                <View style={s.runHead}>
                  <Chip label={lr.status} tone={statusTone(lr.status)} glyph={statusIcon(lr.status)} />
                  <Text style={s.runId}>{lr.id.slice(0, 8)}</Text>
                  <Text style={s.ago}>{ago(lr.startedAt)}</Text>
                </View>
                <Text style={s.summary}>{lr.summary}</Text>
              </View>
            )}
          </Card>
        </Section>
      ) : null}

      {/* ── Recent tasks ───────────────────────────────────────────────────── */}
      {data ? (
        <Section title="Recent Tasks">
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {data.recentTasks.length === 0 ? (
              <Empty text="No tasks assigned to this agent yet." />
            ) : (
              data.recentTasks.map((t, i) => (
                <View key={t.id} style={[s.task, i > 0 && s.taskDivider]}>
                  <Text style={s.taskTitle} numberOfLines={1}>
                    {t.title}
                  </Text>
                  <Chip label={t.status} tone={statusTone(t.status)} glyph={statusIcon(t.status)} />
                </View>
              ))
            )}
          </Card>
        </Section>
      ) : null}

      {/* ── Task distributions ─────────────────────────────────────────────── */}
      {o ? (
        <Section title={`Tasks · last ${o.days} days`}>
          <Card style={{ gap: space.lg }}>
            <Distribution title="By status" rows={o.tasksByStatus} withGlyph />
            <Distribution title="By priority" rows={o.tasksByPriority} />
          </Card>
        </Section>
      ) : null}

      {/* ── Costs ──────────────────────────────────────────────────────────── */}
      {o ? (
        <Section title="Costs">
          <Card>
            {/* The split is null for tasks recorded before AG2 — show a dash, not
                a fake 0, exactly as the web does. */}
            <Row label="Input tokens" value={o.costs.hasSplit ? formatTokens(o.costs.inputTokens) : NONE} />
            <Row label="Output tokens" value={o.costs.hasSplit ? formatTokens(o.costs.outputTokens) : NONE} />
            <Row label="Cached tokens" value={o.costs.hasSplit ? formatTokens(o.costs.cachedTokens) : NONE} />
            <Row label="Total tokens" value={formatTokens(o.costs.totalTokens)} />
            <Row label="Tasks" value={formatTokens(o.costs.taskCount)} />
            <Row label="Total cost" value={formatCost(o.costs.totalCostUsd)} accent />
          </Card>
          {!o.costs.hasSplit && o.costs.totalTokens > 0 ? (
            <Text style={s.note}>
              The input/output/cached split is recorded from this release onward; earlier tasks carry
              only the total.
            </Text>
          ) : null}
        </Section>
      ) : null}
    </ScrollView>
  )
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: space.xl }}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, accent && { color: theme.blue, fontWeight: '800' }]}>{value}</Text>
    </View>
  )
}

/**
 * Label + count + proportional bar. The label and the number carry the meaning;
 * the bar is proportion only — which is why this one survives the phone and the
 * day-columns don't.
 */
function Distribution({
  title,
  rows,
  withGlyph,
}: {
  title: string
  rows: { key: string; count: number }[]
  withGlyph?: boolean
}) {
  const peak = Math.max(1, ...rows.map((r) => r.count))
  return (
    <View>
      <Text style={s.distTitle}>{title}</Text>
      {rows.length === 0 ? (
        <Text style={s.empty}>No tasks in this window.</Text>
      ) : (
        rows.map((r) => (
          <View key={r.key} style={s.distRow}>
            <Text style={s.distLabel} numberOfLines={1}>
              {withGlyph ? `${statusIcon(r.key)} ` : ''}
              {r.key.replace('_', ' ')}
            </Text>
            <View style={s.distTrack}>
              <View style={[s.distFill, { width: `${Math.max((r.count / peak) * 100, 4)}%` }]} />
            </View>
            <Text style={s.distCount}>{r.count}</Text>
          </View>
        ))
      )}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { fontSize: 34 },
  name: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  role: { color: theme.textDim, fontSize: font.sm, marginTop: 2 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  sectionTitle: {
    color: theme.textDim,
    fontSize: font.sm,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.sm,
  },
  rowLabel: { color: theme.textDim, fontSize: font.sm },
  rowValue: { color: theme.text, fontSize: font.sm, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  note: { color: theme.textFaint, fontSize: font.sm - 1, marginTop: space.sm, lineHeight: 17 },
  runHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  runId: { color: theme.textFaint, fontSize: font.sm - 1, fontFamily: 'Courier' },
  ago: { color: theme.textFaint, fontSize: font.sm - 1, marginLeft: 'auto' },
  summary: { color: theme.text, fontSize: font.base, lineHeight: 21 },
  empty: { color: theme.textDim, fontSize: font.sm, paddingVertical: space.sm },
  task: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  taskDivider: { borderTopWidth: 1, borderTopColor: theme.s3 },
  taskTitle: { color: theme.text, fontSize: font.sm, flex: 1 },
  distTitle: { color: theme.text, fontSize: font.sm, fontWeight: '700', marginBottom: space.sm },
  distRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  distLabel: { color: theme.textDim, fontSize: font.sm - 1, width: 104, textTransform: 'capitalize' },
  distTrack: { flex: 1, height: 8, backgroundColor: theme.s2, borderRadius: radius.sm, overflow: 'hidden' },
  distFill: { height: '100%', backgroundColor: theme.blue, borderRadius: radius.sm },
  distCount: { color: theme.textDim, fontSize: font.sm - 1, width: 26, textAlign: 'right' },
})
