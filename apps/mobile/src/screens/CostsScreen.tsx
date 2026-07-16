// MOB-6d — the Cost Centre. Read-only, replacing the `costs` placeholder.
//
// MIRRORS the web's `costs` tab (web/app/dashboard/page.tsx) over the same two
// calls — and note that neither of them is a costs endpoint:
//
//   GET /api/orgs/:orgId/tasks   → every cost figure on this screen (the web
//                                  sums the same array; backend caps it at 200)
//   GET /api/orgs/:orgId/agents  → the roster the breakdown iterates
//
// The backend has a `/api/orgs/:orgId/costs` that would aggregate this
// server-side, which is the obvious thing to want on a phone. We don't call it:
// it is windowed (7d/30d/90d) and the web's sum isn't, so the two produce
// different totals for the same org — the same spend telling two stories
// depending on which device you picked up. costs.ts spells this out in full.
//
// The web's layout is a 4-up stat grid + a By Agent list of proportional bars.
// The stats stack two-up here; the bars are DEFERRED (see below). The DATA is
// the web's, the layout is what a 390pt screen can hold — the same trade the
// Task Log makes.
//
// WHY NO BARS: the web draws each agent's share as a proportional bar. At phone
// width a bar for a 3% share is about ten points long — indistinguishable from
// one for 1%, and from zero. So the share is printed as a number instead, which
// carries the same fact legibly and, unlike a bar, is readable to a screen
// reader and doesn't lean on hue. Deferred, not dropped: docs/DESIGN-mobile-parity.md
// §6.5 records it.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api, type Agent, type Task } from '../api'
import { useAuth } from '../auth'
import {
  SPEND_SCOPE_NOTE,
  costsByAgent,
  doneCount,
  formatShare,
  formatSpend,
  formatTokensK,
  totalCost,
  totalTokens,
} from '../costs'
import { font, space, theme } from '../theme'
import { Banner, Card, Empty, Loading } from '../ui'

/** One of the web's four stat cards. Label under value, as on the desk. */
function Stat({ value, label, tone }: { value: string; label: string; tone?: 'accent' | 'info' }) {
  return (
    <Card style={s.stat}>
      <Text
        style={[
          s.statVal,
          tone === 'accent' && { color: theme.blue },
          tone === 'info' && { color: theme.purple },
        ]}
      >
        {value}
      </Text>
      <Text style={s.statLabel}>{label}</Text>
    </Card>
  )
}

export default function CostsScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    // The tasks are the screen — every figure comes from them. The roster only
    // names the breakdown's rows, so losing it must not cost the totals: an
    // unnamed agent is a worse screen than no screen, but not by much.
    const [t, a] = await Promise.allSettled([
      Api.tasks(apiUrl, token, orgId),
      Api.agents(apiUrl, token, orgId),
    ])
    if (t.status === 'fulfilled') setTasks(t.value)
    else {
      setError(t.reason?.message ?? 'Failed to load costs.')
      setTasks([])
    }
    if (a.status === 'fulfilled') setAgents(a.value)
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(() => (tasks ? costsByAgent(tasks, agents) : []), [tasks, agents])
  const spend = useMemo(() => (tasks ? totalCost(tasks) : 0), [tasks])

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={tasks === null} onRefresh={load} tintColor={theme.blue} />
      }
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {tasks === null ? (
        <Loading text="Loading costs…" />
      ) : (
        <>
          {/* The web's four stat cards, two-up. Same figures, same precision. */}
          <View style={s.grid}>
            <Stat value={formatSpend(spend)} label="Total Spend" tone="accent" />
            <Stat value={formatTokensK(totalTokens(tasks))} label="Total Tokens" />
            <Stat value={String(doneCount(tasks))} label="Done" />
            <Stat value={String(agents.length)} label="Agents" tone="info" />
          </View>

          {/* The web lets a capped total read as a lifetime one. Don't. */}
          <Text style={s.note}>{SPEND_SCOPE_NOTE}</Text>

          <Text style={s.h2}>By Agent</Text>
          {rows.length === 0 ? (
            <Empty text="No agents in this organisation yet." />
          ) : (
            rows.map((r) => (
              <Card key={r.agent.id} style={{ marginBottom: space.md }}>
                <View style={s.row}>
                  <Text style={s.avatar}>{r.agent.avatarEmoji || '🤖'}</Text>
                  <Text style={s.name} numberOfLines={1}>
                    {r.agent.name}
                  </Text>
                  {/* The share the web draws as a bar — printed, so 3% and 1%
                      are actually different at this width. */}
                  <Text style={s.share}>{formatShare(r.pct)}</Text>
                  <Text style={s.cost}>{formatSpend(r.cost)}</Text>
                </View>
              </Card>
            ))
          )}

          {/* Budgets is a hosted tab under Costs on the web (navModel:
              webHosted:'costs'). The phone has no rail to fold, so the fold shows
              up as a sibling row under Delivery — this is the signpost to it, so
              the pairing survives the flattening. */}
          <Text style={s.hint}>Budget caps live under More › Delivery › Budgets.</Text>
        </>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  // Two-up: 50% minus half the gap.
  stat: { flexBasis: '47%', flexGrow: 1, alignItems: 'flex-start' },
  statVal: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  statLabel: { color: theme.textDim, fontSize: font.sm, marginTop: space.xs },
  note: { color: theme.textFaint, fontSize: font.sm - 1, marginTop: space.md, lineHeight: 18 },
  h2: {
    color: theme.text,
    fontSize: font.lg,
    fontWeight: '800',
    marginTop: space.xl,
    marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { fontSize: 22 },
  name: { color: theme.text, fontSize: font.base, fontWeight: '600', flex: 1 },
  share: { color: theme.textFaint, fontSize: font.sm, fontWeight: '600', minWidth: 40, textAlign: 'right' },
  cost: {
    color: theme.blue,
    fontSize: font.sm,
    fontWeight: '700',
    minWidth: 74,
    textAlign: 'right',
  },
  hint: { color: theme.textFaint, fontSize: font.sm, marginTop: space.xl, lineHeight: 19 },
})
