'use client'
// ACT-1 — the ACTIVITY LOG: what the office has actually been doing.
//
// This sits under TimelineSection, and the pair is deliberate rather than redundant.
// The timeline is a 24h heartbeat SWIMLANE — it answers "who was busy, when". It has
// never been able to answer "what happened", because it only ever knew about runs and
// tasks. Approvals, connector executions and the audit trail were all written and never
// shown. This section is the log: one reverse-chronological feed over all five sources,
// from GET /api/orgs/:orgId/activity.
//
// WHY THIS SECTION OWNS ITS OWN FETCH, against CockpitPanel's usual "composition root
// owns all state" rule: filters and cursor paging are local, per-view concerns, and
// hoisting them would put a page cursor and a kind filter into the panel that every
// other section re-renders on. The panel still owns the ONE-SHOT data; this owns its
// own pagination. It re-fetches from page one whenever a filter changes, which is the
// only correct thing to do with a cursor.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, Pill, SectionLabel, Select, Skeleton } from '../ui'
import { sx, type CAgent, type Getter } from './shared'
import {
  ACTIVITY_KINDS, KIND_GLYPH, KIND_LABEL, OUTCOME_LABEL, OWNER_ONLY_KINDS,
  activityAgo, activityQuery, type ActivityEvent, type ActivityKind, type ActivityOutcome,
} from '@/lib/activityKinds'
import type { PillTone } from '../ui'

/** Outcome → the DESK's chip vocabulary. Local on purpose: the phone's Chip speaks a
 *  different one, so this mapping is the surface's business (see the note in
 *  lib/activityKinds.ts). Colour is never the only signal — every Pill carries its
 *  label text too. */
export const OUTCOME_TONE: Record<ActivityOutcome, PillTone> = {
  pending: 'warn',
  running: 'warn',
  ok: 'ok',
  failed: 'fail',
  rejected: 'fail',
  info: 'muted',
}

type FeedResponse = {
  events: ActivityEvent[]
  nextCursor: string | null
  availableKinds: ActivityKind[]
  isOwner: boolean
}

const PAGE = 40

export default function ActivityLogSection({ orgId, getToken, agents, onOpenAgent }: {
  orgId: string
  getToken: Getter
  /** For the agent filter's labels. The feed itself carries `agentName`, so this is
   *  only used to populate the picker. */
  agents: CAgent[]
  onOpenAgent?: (agentId: string) => void
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [availableKinds, setAvailableKinds] = useState<ActivityKind[]>([...ACTIVITY_KINDS])
  const [isOwner, setIsOwner] = useState(true)
  const [kind, setKind] = useState<ActivityKind | 'all'>('all')
  const [agentId, setAgentId] = useState<string>('all')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Rendered ages are relative, so they need a "now". Taken once per load rather than
  // per render, so rows don't renumber themselves mid-scroll.
  const [now, setNow] = useState(() => Date.now())

  // The query string comes from the SHARED builder, so the desk and the phone ask the
  // endpoint the same question (see lib/activityKinds.ts).
  const qs = useCallback(
    (after: string | null) => activityQuery({ kind, agentId, cursor: after, limit: PAGE }),
    [kind, agentId],
  )

  /** Load page one. Called on mount and on every filter change — a cursor from the
   *  previous filter is meaningless against a different query, so it is dropped. */
  const load = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api<FeedResponse>(`/api/orgs/${orgId}/activity?${qs(null)}`, { token: await getToken() })
      setEvents(r.events ?? [])
      setCursor(r.nextCursor ?? null)
      setAvailableKinds(r.availableKinds ?? [...ACTIVITY_KINDS])
      setIsOwner(!!r.isOwner)
      setNow(Date.now())
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load activity')
      setEvents([])
    } finally { setBusy(false) }
  }, [orgId, getToken, qs])

  useEffect(() => { load() }, [load])

  /** Append the next page. APPEND, never replace — and only on success, so a failed
   *  "Load more" leaves what the operator was already reading on screen. */
  const more = async () => {
    if (!cursor || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await api<FeedResponse>(`/api/orgs/${orgId}/activity?${qs(cursor)}`, { token: await getToken() })
      setEvents(cur => [...(cur ?? []), ...(r.events ?? [])])
      setCursor(r.nextCursor ?? null)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load more')
    } finally { setBusy(false) }
  }

  const chips: Array<{ id: ActivityKind | 'all'; label: string }> = [
    { id: 'all', label: 'Everything' },
    ...availableKinds.map(k => ({ id: k, label: KIND_LABEL[k] })),
  ]
  const hiddenOwnerKinds = OWNER_ONLY_KINDS.filter(k => !availableKinds.includes(k))

  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ marginBottom: 0 }}>Activity log</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          {agents.length > 0 && (
            <Select
              aria-label="Filter activity by agent"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              style={{ maxWidth: 180 }}
            >
              <option value="all">All agents</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.avatarEmoji} {a.name}</option>)}
            </Select>
          )}
          <Button onClick={load} disabled={busy} aria-label="Refresh activity">↻ Refresh</Button>
        </div>
      </div>

      {/* Kind filters. Only kinds THIS caller may actually read are offered — the
          server decides that, and it tells us in `availableKinds`. Offering a chip
          that always returns nothing would read as "the office did nothing". */}
      <div role="group" aria-label="Filter activity by kind" style={{ display: 'flex', flexWrap: 'wrap', gap: space.xs, marginBottom: space.sm }}>
        {chips.map(c => {
          const on = kind === c.id
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => setKind(c.id)}
              style={{
                ...sx.tag, cursor: 'pointer',
                background: on ? 'var(--accent-bg)' : tk.surfaceHigh,
                color: on ? 'var(--accent)' : tk.textDim,
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line-strong)'}`,
              }}
            >
              {c.id === 'all' ? '◍' : KIND_GLYPH[c.id as ActivityKind]} {c.label}
            </button>
          )
        })}
      </div>

      {err && <p role="alert" style={{ ...sx.empty, color: 'var(--danger-text)' }}>{err}</p>}

      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {events === null ? (
          <div style={{ padding: space.lg }}><Skeleton h={14} /><Skeleton h={14} style={{ marginTop: space.sm }} /><Skeleton h={14} style={{ marginTop: space.sm }} /></div>
        ) : events.length === 0 ? (
          // A real empty state, not a vanished section. It also distinguishes "nothing
          // happened" from "nothing MATCHED", which is the difference between a quiet
          // office and a filter the operator forgot they set.
          <p style={{ ...sx.empty, padding: `${space.lg}px 0` }}>
            {kind === 'all' && agentId === 'all'
              ? 'Nothing has happened yet. Approvals, connector runs, agent runs and tasks will appear here as they occur.'
              : 'No activity matches this filter. Try “Everything”, or a different agent.'}
          </p>
        ) : (
          events.map(e => {
            const tone = OUTCOME_TONE[e.outcome] ?? 'muted'
            return (
              <div key={e.id} style={sx.row}>
                <span aria-hidden style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>{KIND_GLYPH[e.kind] ?? '•'}</span>
                <span style={{ ...sx.badge, flexShrink: 0 }}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.title}>
                  {e.title}
                </span>
                {e.target && (
                  <span style={{ ...sx.badge, flexShrink: 0, fontWeight: 500 }} title={e.target}>{e.target}</span>
                )}
                {e.agentName && (
                  onOpenAgent && e.agentId ? (
                    <button
                      type="button"
                      onClick={() => onOpenAgent(e.agentId!)}
                      style={{ ...sx.badge, flexShrink: 0, cursor: 'pointer', background: 'transparent' }}
                    >{e.agentName}</button>
                  ) : (
                    <span style={{ ...sx.badge, flexShrink: 0 }}>{e.agentName}</span>
                  )
                )}
                <Pill tone={tone} style={{ flexShrink: 0 }}>{OUTCOME_LABEL[e.outcome] ?? e.outcome}</Pill>
                <span style={{ color: tk.muted, fontSize: text.xs.fontSize, flexShrink: 0, width: 76, textAlign: 'right' }}>
                  {activityAgo(e.at, now)}
                </span>
              </div>
            )
          })
        )}
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, marginTop: space.sm }}>
        {/* BOUNDED by construction: there is no infinite scroll and no "load all". The
            operator asks for each additional page. */}
        {cursor && (
          <Button onClick={more} disabled={busy}>{busy ? 'Loading…' : `Load ${PAGE} more`}</Button>
        )}
        {events !== null && events.length > 0 && (
          <span style={{ color: tk.muted, fontSize: text.xs.fontSize }}>
            Showing {events.length}{cursor ? '' : ' — that’s everything'}
          </span>
        )}
        {!isOwner && hiddenOwnerKinds.length > 0 && (
          // Explain the absence rather than silently showing a thinner feed: a member
          // who can't see connector runs should know they exist, not conclude the
          // office never used a connector.
          <span style={{ color: tk.muted, fontSize: text.xs.fontSize }}>
            {hiddenOwnerKinds.map(k => KIND_LABEL[k]).join(' and ')} events are visible to owners only.
          </span>
        )}
      </div>
    </div>
  )
}
