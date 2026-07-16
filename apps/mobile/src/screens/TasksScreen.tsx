// MOB-6b — the Task Log. Read-only, replacing the `tasks` placeholder.
//
// MIRRORS the web's `tasks` tab (web/app/dashboard/page.tsx) over the same call:
//
//   GET /api/orgs/:orgId/tasks              → the log (backend caps at 200,
//                                             newest first; we render 100 as the
//                                             web does)
//   GET /api/orgs/:orgId/agents             → the agent names/emoji the log joins
//   GET /api/orgs/:orgId/approvals?status=pending → the approvals affordance
//
// The web's log is a 5-column table (Task · Agent · Status · Cost · Tokens). A
// 390pt screen has no room for five columns, so each row becomes a card with the
// same five facts stacked — the DATA is mirrored, the layout is what a phone can
// hold. Every formatting rule (the 100 cap, the 60-char title cut, cost at 5dp,
// the em-dash for unrecorded values) lives in `taskLog.ts` and is pinned by
// `taskLog.test.ts`, so the numbers here are the numbers on the desk.
//
// P2 (web #286): Tasks and the approvals it feeds are ONE area. The web puts an
// approvals link above the log; so does this, and it jumps to the Inbox tab the
// phone already has.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api, type Agent, type Task } from '../api'
import { useAuth } from '../auth'
import { statusIcon, statusTone } from '../status'
import { agentLabel, approvalsLabel, formatCost, formatTokens, taskLogRows, taskTitle } from '../taskLog'
import { font, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'

export default function TasksScreen({ onOpenTab }: { onOpenTab?: (tab: string) => void }) {
  const { apiUrl, getToken, orgId } = useAuth()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    // The log is the screen; the agent names and the approvals count are
    // garnish. A failure on either must not cost the operator the log itself —
    // an unnamed agent still shows its task.
    const [t, a, p] = await Promise.allSettled([
      Api.tasks(apiUrl, token, orgId),
      Api.agents(apiUrl, token, orgId),
      Api.pendingApprovals(apiUrl, token, orgId),
    ])
    if (t.status === 'fulfilled') setTasks(t.value)
    else {
      setError(t.reason?.message ?? 'Failed to load tasks.')
      setTasks([])
    }
    if (a.status === 'fulfilled') setAgents(a.value)
    // A failed approvals fetch leaves the affordance out entirely rather than
    // claiming "0 pending" — a false all-clear is worse than no claim.
    setPending(p.status === 'fulfilled' ? p.value.length : null)
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const rows = useMemo(() => (tasks ? taskLogRows(tasks) : []), [tasks])

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={tasks === null} onRefresh={load} tintColor={theme.blue} />}
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {/* The web's approvals affordance, same wording, same threshold. */}
      {pending !== null && onOpenTab ? (
        <Pressable
          accessibilityRole="button"
          // The web's `selectTab('inbox')` — same id, same destination.
          onPress={() => onOpenTab('inbox')}
          style={({ pressed }) => [s.approvals, pressed && { opacity: 0.7 }]}
        >
          <Text style={[s.approvalsText, pending > 0 && { color: theme.orange }]}>
            {approvalsLabel(pending)}
          </Text>
        </Pressable>
      ) : null}

      {tasks === null ? (
        <Loading text="Loading tasks…" />
      ) : rows.length === 0 ? (
        <Empty text="No tasks in this organisation yet." />
      ) : (
        <>
          <Text style={s.count}>
            {/* Say when the view is capped rather than letting 100 read as "all". */}
            Task Log ({tasks.length}
            {rows.length < tasks.length ? ` · showing ${rows.length}` : ''})
          </Text>
          {rows.map((t) => (
            <Card key={t.id} style={{ marginBottom: space.md }}>
              <Text style={s.title}>{taskTitle(t.title)}</Text>
              <View style={s.meta}>
                <Text style={s.agent} numberOfLines={1}>
                  {agentLabel(agentById.get(t.agentId ?? ''))}
                </Text>
                <Chip label={t.status} tone={statusTone(t.status)} glyph={statusIcon(t.status)} />
              </View>
              <View style={s.nums}>
                <Text style={s.cost}>{formatCost(t.costUsd)}</Text>
                <Text style={s.tokens}>{formatTokens(t.tokensUsed)} tokens</Text>
              </View>
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  approvals: {
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: 10,
    padding: space.md,
    marginBottom: space.lg,
    backgroundColor: theme.s1,
  },
  approvalsText: { color: theme.textDim, fontSize: font.sm, fontWeight: '700' },
  count: { color: theme.textDim, fontSize: font.sm, fontWeight: '700', marginBottom: space.md },
  title: { color: theme.text, fontSize: font.base, fontWeight: '600' },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginTop: space.md,
  },
  agent: { color: theme.textDim, fontSize: font.sm, flex: 1 },
  nums: { flexDirection: 'row', gap: space.lg, marginTop: space.sm },
  cost: { color: theme.blue, fontSize: font.sm - 1, fontWeight: '600' },
  tokens: { color: theme.textFaint, fontSize: font.sm - 1 },
})
