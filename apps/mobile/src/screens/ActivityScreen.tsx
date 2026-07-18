// ACT-1 — the Activity LOG, mirroring the desk's ActivityLogSection over the same call:
//
//   GET /api/orgs/:orgId/activity → approvals filed + decided, connector executions,
//                                   agent runs, tasks, audit events — one feed
//
// WHAT CHANGED, and why the MOB-7c screen this replaces was not wrong so much as
// starved: it read `GET /timeline`, which is a 24h heartbeat SWIMLANE and only ever knew
// about runs and tasks. Approvals, the CONN-8b-4 connector ledger and the audit trail
// were all being WRITTEN and shown nowhere. (The MOB-7c header also claimed the
// audit-log plugin was a no-op that recorded nothing — true when written, untrue since
// #257 hoisted the hook onto the root instance. It records.) So the phone now reads the
// unified feed instead of flattening a chart. The swimlane still exists on the desk,
// where a wide canvas makes it legible; it never had a phone peer worth keeping.
//
// NATIVE LIST, not a web table: FlatList with windowing, one Card per row, chips that
// wrap, pull-to-refresh.
//
// PULL-TO-REFRESH IS A CHEAP READ — the MEM-1 lesson. It resets to page one (a cursor
// from a previous read is meaningless against a fresh feed) and fetches exactly ONE
// bounded page: the same call the screen makes on mount. No rebuild, no re-crawl.
//
// BOUNDED: PAGE rows at a time, and "Load more" is a button the operator presses.
// Deliberately NOT `onEndReached` — a fast flick would page the whole ledger over a
// phone connection.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { Api } from '../api'
import {
  KIND_GLYPH,
  KIND_LABEL,
  OWNER_ONLY_KINDS,
  activityAgo,
  activityQuery,
  auditPhrase,
  auditRunLabel,
  awaitsOperator,
  buildFeedRows,
  outcomeLabel,
  type ActivityEvent,
  type ActivityKind,
  type ActivityOutcome,
  type FeedRow,
} from '../activityKinds'
import { useAuth } from '../auth'
import { font, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Empty, Loading } from '../ui'

/** Outcome → the PHONE's Chip vocabulary. Local on purpose: the desk's Pill speaks a
 *  different one ('fail' where this says 'danger'), so a shared tone map would have to
 *  invent a third that neither surface actually uses. See the note in activityKinds.ts.
 *  Colour is never the only signal — every Chip carries its label text. */
const OUTCOME_TONE: Record<ActivityOutcome, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  pending: 'warn',
  running: 'warn',
  ok: 'ok',
  failed: 'danger',
  rejected: 'danger',
  info: 'neutral',
}

/** FIX-1 — tone follows the same kind-awareness as the label. `warn` is the phone's
 *  "this wants you" colour, and spending it on a QUEUED task (every task is born
 *  `pending`) is the colour half of the same lie the badge copy was telling. */
function outcomeTone(kind: ActivityKind, outcome: ActivityOutcome): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (outcome === 'pending') return awaitsOperator({ kind, outcome }) ? 'warn' : 'neutral'
  return OUTCOME_TONE[outcome] ?? 'neutral'
}

const PAGE = 25

export default function ActivityScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [events, setEvents] = useState<ActivityEvent[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [availableKinds, setAvailableKinds] = useState<ActivityKind[] | null>(null)
  const [isOwner, setIsOwner] = useState(true)
  const [kind, setKind] = useState<ActivityKind | 'all'>('all')
  /** FIX-1 — which collapsed audit runs the operator has expanded. Keyed by the run's
   *  first event id, so appending a page never re-collapses something already open. */
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // Ages are relative and need a "now". Sampled per LOAD, not per render, so rows don't
  // renumber themselves while the list is being scrolled.
  const [now, setNow] = useState(() => Date.now())

  /** Page one. Also the pull-to-refresh handler — one bounded read, nothing more. */
  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      const r = await Api.activity(apiUrl, token, orgId, activityQuery({ kind, limit: PAGE }))
      setEvents(r.events ?? [])
      setCursor(r.nextCursor ?? null)
      setAvailableKinds(r.availableKinds ?? null)
      setIsOwner(!!r.isOwner)
      setNow(Date.now())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load activity.')
      // An empty list, not null: null means "still loading" to the spinner below, and a
      // failed load must not spin forever.
      setEvents([])
      setCursor(null)
    }
  }, [apiUrl, getToken, orgId, kind])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  /** Append the next page. APPEND, and only on success — a failed "Load more" must
   *  leave what the operator was already reading on screen. */
  const more = useCallback(async () => {
    if (!cursor || loadingMore) return
    const token = await getToken()
    if (!token || !orgId) return
    setLoadingMore(true)
    setError(null)
    try {
      const r = await Api.activity(apiUrl, token, orgId, activityQuery({ kind, cursor, limit: PAGE }))
      setEvents((cur) => [...(cur ?? []), ...(r.events ?? [])])
      setCursor(r.nextCursor ?? null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load more.')
    } finally {
      setLoadingMore(false)
    }
  }, [apiUrl, getToken, orgId, kind, cursor, loadingMore])

  // Only kinds THIS caller may actually read are offered. The server says which; a chip
  // that always returned nothing would read as "the office did nothing".
  const chips = useMemo(() => {
    const ks = availableKinds ?? []
    return [{ id: 'all' as ActivityKind | 'all', label: 'All', glyph: '◍' }].concat(
      ks.map((k) => ({ id: k as ActivityKind | 'all', label: KIND_LABEL[k], glyph: KIND_GLYPH[k] })),
    )
  }, [availableKinds])

  const hiddenOwnerKinds = useMemo(
    () => (availableKinds ? OWNER_ONLY_KINDS.filter((k) => !availableKinds.includes(k)) : []),
    [availableKinds],
  )

  /** One event card. Extracted so an expanded audit run renders the SAME card for its
   *  children — an expanded audit event must not be a second, lesser rendering. */
  const EventCard = useCallback(
    ({ e, muted }: { e: ActivityEvent; muted?: boolean }) => {
      // FIX-1 — an audit row's own `title` is a machine string (`post.orgs`) and its
      // target is a method + a uuid-bearing path. Both collapse into the shared human
      // phrase; nothing is dropped from the payload, only from the glance.
      const isAudit = e.kind === 'audit_event'
      return (
        <Card style={[{ marginBottom: space.md }, muted ? { opacity: 0.75 } : null]}>
          <View style={s.head}>
            <Text style={s.glyph}>{KIND_GLYPH[e.kind] ?? '•'}</Text>
            <Text style={s.kind} numberOfLines={1}>
              {KIND_LABEL[e.kind] ?? e.kind}
            </Text>
            <Chip label={outcomeLabel(e.kind, e.outcome)} tone={outcomeTone(e.kind, e.outcome)} />
          </View>
          <Text style={s.title} numberOfLines={2}>
            {isAudit ? auditPhrase(e.title, e.target) : e.title}
          </Text>
          <View style={s.meta}>
            {e.agentName ? <Text style={s.agent}>{e.agentName}</Text> : null}
            {!isAudit && e.target ? (
              <Text style={s.target} numberOfLines={1}>
                {e.target}
              </Text>
            ) : null}
            <Text style={s.when}>{activityAgo(e.at, now)}</Text>
          </View>
          {/* Already truncated and sanitized server-side. Shown rather than hidden: a
              failure the operator cannot see is a failure they cannot act on. */}
          {e.error ? (
            <Text style={s.error} numberOfLines={2}>
              {e.error}
            </Text>
          ) : null}
        </Card>
      )
    },
    [now],
  )

  const renderRow = useCallback(
    ({ item }: { item: FeedRow }) => {
      if (item.row === 'event') return <EventCard e={item.event} />
      const open = openRuns.has(item.run.key)
      return (
        <View>
          <Pressable
            onPress={() =>
              setOpenRuns((prev) => {
                const next = new Set(prev)
                if (next.has(item.run.key)) next.delete(item.run.key)
                else next.add(item.run.key)
                return next
              })
            }
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${open ? 'Hide' : 'Show'} ${auditRunLabel(item.run.count)}`}
            style={s.runRow}
          >
            <Text style={s.glyph}>{KIND_GLYPH.audit_event}</Text>
            <Text style={s.runText} numberOfLines={1}>
              {auditRunLabel(item.run.count)}
            </Text>
            <Text style={s.runToggle}>{open ? 'Hide' : 'Show'}</Text>
          </Pressable>
          {open ? item.run.items.map((e) => <EventCard key={e.id} e={e} muted />) : null}
        </View>
      )
    },
    [EventCard, openRuns],
  )

  // FIX-1 — the default view leads with what HAPPENED; runs of routine audit rows
  // collapse into one tappable line. Picking the Audit chip passes collapse:false, so
  // asking for them explicitly still shows every one. Order is never changed.
  const rows = useMemo(
    () => (events ? buildFeedRows(events, { collapse: kind === 'all' }) : []),
    [events, kind],
  )

  return (
    <View style={s.wrap}>
      {/* Filter chips — a row of tappable chips reads faster on a phone than a modal
          picker, and keeps the current filter visible while scrolling. */}
      <View style={s.filters}>
        {chips.map((c) => {
          const on = kind === c.id
          return (
            <Pressable
              key={c.id}
              onPress={() => setKind(c.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Show ${c.label}`}
              style={[s.filter, on && s.filterOn]}
            >
              <Text style={[s.filterText, on && s.filterTextOn]} numberOfLines={1}>
                {c.glyph} {c.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {error ? (
        <View style={{ marginBottom: space.md }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {events === null ? (
        <Loading text="Loading activity…" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => (r.row === 'event' ? r.event.id : r.run.key)}
          renderItem={renderRow}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.blue} />
          }
          ListEmptyComponent={
            <Empty
              text={
                kind === 'all'
                  ? 'Nothing has happened yet. Approvals, connector runs, agent runs and tasks appear here as they occur.'
                  : `No ${(KIND_LABEL[kind as ActivityKind] ?? kind).toLowerCase()} activity yet. Try “All”.`
              }
            />
          }
          ListFooterComponent={
            <View style={s.footer}>
              {cursor ? (
                <Button
                  title={loadingMore ? 'Loading…' : `Load ${PAGE} more`}
                  onPress={more}
                  disabled={loadingMore}
                />
              ) : events.length > 0 ? (
                <Text style={s.foot}>That’s everything.</Text>
              ) : null}
              {!isOwner && hiddenOwnerKinds.length > 0 ? (
                // Explain the absence rather than silently serving a thinner feed: a
                // member who can't see connector runs should know they exist.
                <Text style={s.foot}>
                  {hiddenOwnerKinds.map((k) => KIND_LABEL[k]).join(' and ')} events are visible to
                  owners only.
                </Text>
              ) : null}
            </View>
          }
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: space.lg },
  // FIX-1 — the collapsed audit line. Deliberately quieter than a Card: it is a
  // signpost to routine plumbing, not an event in its own right.
  runRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.sm, paddingHorizontal: space.md, marginBottom: space.md,
  },
  runText: { flex: 1, color: theme.textDim, fontSize: font.sm },
  runToggle: { color: theme.blue, fontSize: font.sm, fontWeight: '600' },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  filter: {
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: 999,
    paddingHorizontal: space.md,
    paddingVertical: 4,
  },
  filterOn: { borderColor: theme.blue, backgroundColor: theme.s2 },
  filterText: { color: theme.textDim, fontSize: font.sm - 1, fontWeight: '600' },
  filterTextOn: { color: theme.blue },
  list: { paddingBottom: space.xl },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  glyph: { fontSize: font.base },
  kind: { flex: 1, color: theme.textDim, fontSize: font.sm, fontWeight: '700' },
  title: { color: theme.text, fontSize: font.base, fontWeight: '600', marginTop: space.sm },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.sm,
  },
  agent: { color: theme.text, fontSize: font.sm - 1, fontWeight: '600' },
  target: { color: theme.textFaint, fontSize: font.sm - 1, maxWidth: 180 },
  when: { color: theme.textFaint, fontSize: font.sm - 1 },
  error: { color: theme.vermillion, fontSize: font.sm - 1, marginTop: space.sm },
  footer: { gap: space.md, paddingTop: space.sm },
  foot: { color: theme.textFaint, fontSize: font.sm - 1, textAlign: 'center' },
})
