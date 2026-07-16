// MOB-6d — the Activity feed, mirrored from the web's Activity section
// (web/app/dashboard/CockpitPanel.tsx → cockpit/TimelineSection.tsx) over the
// same call: GET /api/orgs/:orgId/timeline.
//
// WHAT THE WEB'S ACTIVITY ACTUALLY IS, because the name misleads: it is not an
// audit log. It is a 24h heartbeat SWIMLANE — one lane per agent, each lane
// carrying blocks for the runs and tasks that touched the window, projected onto
// it as start/width percentages. (There IS an `audit_logs` table, and it would
// have been the obvious source for an actor/action/target feed, but the plugin
// that writes it is a no-op — it records nothing. A feed built on it would render
// convincingly empty forever. The timeline is the surface that has the data.)
//
// WHAT THE PHONE DOES WITH IT: a swimlane is a chart, and a chart projected onto
// 390pt is a smudge — 24 hours across ~340 usable points makes a 20-minute run
// about four pixels wide. So the phone keeps the DATA and drops the PROJECTION:
// the lanes are flattened back into the event list they were built from and
// shown newest-first, which is the one ordering a phone reads well. Each event
// still carries the same four facts the web's block does — who (the lane's
// agent), what (the block's status), which (its title), when (its start) — plus
// the cost and tokens the web puts in the block's tooltip.
//
// `startPct` / `widthPct` are ignored here ON PURPOSE: they are the projection,
// and they are the only part of the payload that assumes a wide canvas.
//
// Everything below is pure — no React, no react-native — so activity.test.ts can
// load it under `node --test` and pin the rules.

/** A timeline block — the backend's `TLBlock` (backend/src/services/timeline.ts). */
export interface TLBlockLite {
  runId: string | null
  taskId: string | null
  title: string
  status: string
  startMs: number
  /** null while the run is still going. */
  endMs: number | null
  ongoing: boolean
  costUsd: number
  tokensUsed: number
}

/** A timeline lane — the backend's `TLLane`. One agent, its blocks. */
export interface TLLaneLite {
  agentId: string
  name: string
  avatarEmoji: string
  heartbeat: string
  status: string
  blocks: TLBlockLite[]
  runCount: number
  totalCost: number
  activeMs: number
}

/** The payload — the backend's `Timeline`. */
export interface TimelineLite {
  now: number
  windowStart: number
  windowEnd: number
  windowMs: number
  lanes: TLLaneLite[]
}

/**
 * One row of the feed: a block, plus the identity of the lane it came from.
 * Flattening loses the lane, so the actor is carried onto the event itself —
 * "who" is the fact a feed row cannot do without.
 */
export interface ActivityEvent {
  /** Stable list key. Runs and tasks have disjoint id spaces, so one or the other. */
  key: string
  agentId: string
  agentName: string
  avatarEmoji: string
  title: string
  status: string
  startMs: number
  endMs: number | null
  ongoing: boolean
  costUsd: number
  tokensUsed: number
}

/**
 * The feed is capped, matching the Task Log's 100. The backend's own inputs are
 * already bounded (300 tasks + the open/24h runs), but a busy org can still put
 * several hundred blocks on the wire and a phone list should not render all of
 * them. The screen says when the cap bites rather than letting 100 read as "all".
 */
export const ACTIVITY_LIMIT = 100

/** The window the backend builds (`TIMELINE_WINDOW_MS`) — 24h. Pinned by a test. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Flatten the swimlane into a newest-first event feed.
 *
 * Sorted by `startMs` descending — when a run STARTED, not when it ended, which
 * is what the web's lanes are laid out by too (`blocks.sort((x, y) => x.startMs -
 * y.startMs)`, oldest-left). Reversing that ordering is the whole point of a
 * feed: the left edge of a chart is the bottom of a list.
 */
export function activityFeed(timeline: TimelineLite | null | undefined): ActivityEvent[] {
  if (!timeline?.lanes) return []
  const events: ActivityEvent[] = []
  for (const lane of timeline.lanes) {
    for (const b of lane.blocks ?? []) {
      events.push({
        key: eventKey(lane, b),
        agentId: lane.agentId,
        agentName: lane.name,
        avatarEmoji: lane.avatarEmoji || '🤖',
        title: b.title,
        status: b.status,
        startMs: b.startMs,
        endMs: b.endMs,
        ongoing: b.ongoing,
        costUsd: b.costUsd,
        tokensUsed: b.tokensUsed,
      })
    }
  }
  // Ties broken by key so the order is deterministic: two runs that start in the
  // same millisecond must not swap places between renders (or between the app and
  // its own test).
  events.sort((a, b) => b.startMs - a.startMs || a.key.localeCompare(b.key))
  return events.slice(0, ACTIVITY_LIMIT)
}

/**
 * A block's list key. `runId` wins where present (a run is the authoritative
 * record — `mergeActivity` drops a task's own block once it has runs), and a
 * task-projected block falls back to its taskId. The agent id and start are
 * folded in because neither id is guaranteed non-null on the wire.
 */
export function eventKey(lane: { agentId: string }, b: TLBlockLite): string {
  const id = b.runId ?? b.taskId ?? 'block'
  return `${lane.agentId}:${id}:${b.startMs}`
}

/** How many blocks the payload held before the cap — for the "showing N" line. */
export function activityCount(timeline: TimelineLite | null | undefined): number {
  if (!timeline?.lanes) return 0
  return timeline.lanes.reduce((n, l) => n + (l.blocks?.length ?? 0), 0)
}

/**
 * "3m ago" / "2h ago" / "just now" — a feed's "when".
 *
 * Relative rather than a clock time on purpose: the timeline is a 24h window, so
 * every row is within a day and "14:32" would make the reader do the subtraction
 * themselves. `now` is passed in rather than read from the clock so this stays
 * pure and testable.
 */
export function formatWhen(startMs: number, now: number): string {
  const secs = Math.max(0, Math.round((now - startMs) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * "1.4s" / "12m" / "2h" — how long the work took. An ongoing block has no end,
 * so it measures against `now` and the caller marks it as still running.
 */
export function formatDuration(startMs: number, endMs: number | null, now: number): string {
  const end = endMs ?? now
  const ms = Math.max(0, end - startMs)
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.round(mins / 60)}h`
}

/**
 * "last 24h" — the window the feed covers, said out loud. The backend's window
 * is exactly 24h today, and that reads better in hours than as "last 1d", so
 * days only kick in past a two-day window.
 */
export function formatWindow(windowMs: number): string {
  const hours = Math.round(windowMs / 3600000)
  return hours > 48 ? `last ${Math.round(hours / 24)}d` : `last ${hours}h`
}
