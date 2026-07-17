// MOB-6d — the Activity feed. Read-only, replacing the `activity` placeholder.
//
// MIRRORS the web's Activity section (web/app/dashboard/CockpitPanel.tsx →
// cockpit/TimelineSection.tsx) over the same call:
//
//   GET /api/orgs/:orgId/timeline → a 24h swimlane: one lane per agent, each
//                                   carrying blocks for the runs/tasks in the window
//
// The web draws that as lanes. The phone flattens it into a newest-first feed —
// the reasoning, and why the audit_logs table was NOT the source despite being
// the obvious one for an "activity" screen, is in activity.ts's header.
//
// Each row is the four facts a feed needs — who · what · which · when — plus the
// cost the web puts in a block's tooltip. Status travels through status.ts, so a
// `running` block reads the same here as on the roster and the agent detail.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { AgentAvatar } from '../AgentAvatar'
import { Api } from '../api'
import {
  actionVerb,
  activityCount,
  activityFeed,
  formatDuration,
  formatWhen,
  formatWindow,
  type TimelineLite,
} from '../activity'
import { useAuth } from '../auth'
import { statusIcon, statusTone } from '../status'
import { formatCost, formatTokens } from '../taskLog'
import { font, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'

export default function ActivityScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [timeline, setTimeline] = useState<TimelineLite | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      setTimeline(await Api.timeline(apiUrl, token, orgId))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load activity.')
      // An empty timeline, not null: null means "still loading" to the spinner
      // below, and a failed load must not spin forever.
      setTimeline({ now: Date.now(), windowStart: 0, windowEnd: 0, windowMs: 0, lanes: [] })
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const feed = useMemo(() => activityFeed(timeline), [timeline])
  const total = useMemo(() => activityCount(timeline), [timeline])

  // The payload's own clock, not the phone's: every block was projected against
  // the server's `now`, so measuring "3m ago" against a phone whose clock is off
  // (or that has been asleep) would drift the whole feed. Fall back to the device
  // only when there's no payload to read it from.
  const now = timeline?.now ?? Date.now()

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={timeline === null} onRefresh={load} tintColor={theme.blue} />
      }
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {timeline === null ? (
        <Loading text="Loading activity…" />
      ) : feed.length === 0 ? (
        // Say WHICH window is empty. "No activity" alone would read as "this org
        // has never done anything" when it only means "not in the last 24h".
        <Empty text={`Nothing has run in the ${formatWindow(timeline.windowMs)}.`} />
      ) : (
        <>
          <Text style={s.count}>
            {/* The window is the headline fact: this is not "all activity". */}
            Activity · {formatWindow(timeline.windowMs)} ({total}
            {feed.length < total ? ` · showing ${feed.length}` : ''})
          </Text>
          {feed.map((e) => (
            <Card key={e.key} style={{ marginBottom: space.md }}>
              {/* MOB-7c — a log line: WHO (avatar + name) did WHAT (the verb),
                  with the state as a glyph+label chip on the right. The timeline
                  lanes carry only `avatarEmoji` (no picture), exactly as the web's
                  own swimlane does, so this actor is emoji here by data — the
                  shared AgentAvatar just frames it like the roster and detail. */}
              <View style={s.actor}>
                <AgentAvatar agent={{ avatarEmoji: e.avatarEmoji }} size={22} />
                <Text style={s.actorText} numberOfLines={1}>
                  <Text style={s.agentName}>{e.agentName}</Text>
                  <Text style={s.verb}> {actionVerb(e.status, e.ongoing)}</Text>
                </Text>
                <Chip label={e.status} tone={statusTone(e.status)} glyph={statusIcon(e.status)} />
              </View>
              {/* WHICH — the task/run the action was on. */}
              <Text style={s.title} numberOfLines={2}>
                {e.title}
              </Text>
              <View style={s.nums}>
                <Text style={s.when}>
                  {formatWhen(e.startMs, now)} · {formatDuration(e.startMs, e.endMs, now)}
                  {e.ongoing ? ' so far' : ''}
                </Text>
                {/* A zero here means "this run row recorded no cost", NOT "free"
                    — a run's cost lives on the run, and the task it points at may
                    well have cost money (activity.test.ts pins that trap). So a
                    zero is left out rather than printed as $0.00000. */}
                {e.costUsd > 0 ? <Text style={s.cost}>{formatCost(e.costUsd)}</Text> : null}
                {e.tokensUsed > 0 ? (
                  <Text style={s.tokens}>{formatTokens(e.tokensUsed)} tokens</Text>
                ) : null}
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
  count: { color: theme.textDim, fontSize: font.sm, fontWeight: '700', marginBottom: space.md },
  actor: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actorText: { flex: 1, fontSize: font.sm },
  agentName: { color: theme.text, fontWeight: '700' },
  verb: { color: theme.textDim },
  title: { color: theme.text, fontSize: font.base, fontWeight: '600', marginTop: space.sm },
  nums: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md, marginTop: space.sm },
  when: { color: theme.textFaint, fontSize: font.sm - 1 },
  cost: { color: theme.blue, fontSize: font.sm - 1, fontWeight: '600' },
  tokens: { color: theme.textFaint, fontSize: font.sm - 1 },
})
