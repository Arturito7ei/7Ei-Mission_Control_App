// MOB-6e — the Org chart. Read-only, replacing the `org` placeholder.
//
// MIRRORS the web's `org` surface (web/app/dashboard/cockpit/OrgChart.tsx) over
// the same call:
//
//   GET /api/orgs/:orgId/orgchart  → { tree, agents, count }
//
// We read `agents` (the flat roster) and derive the tree with org.ts, exactly as
// the web derives it with lib/orgLayout — same endpoint, same field, same
// derivation, and `org.test.ts` pins the two together. The backend also ships a
// pre-nested `tree`, which NEITHER client reads; leaving it alone on both is what
// stops a second answer to "who reports to whom" appearing.
//
// WHAT CARRIES OVER: the hierarchy — who reports to whom, and each agent's
// identity line (avatar, name, title/role, runtime · model, status). That's the
// question the screen exists to answer, and it's device-independent.
//
// WHAT'S DROPPED: the canvas. The web positions cards with `layoutOrgTree`,
// draws elbowed SVG edges under them, and pans/zooms/fits with pointer maths.
// All of that answers "where on a 2000px canvas does this card sit" — a question
// a 390pt column never asks. Indentation says the same thing about depth in a
// tenth of the code and none of the gestures. DROPPED, not deferred — parity doc
// §6.6. The screen says so itself (ORG_CANVAS_NOTE) rather than leaving the
// operator hunting for a drag that isn't coming.
//
// ALSO DROPPED: Import/Export company (the web's two buttons above the canvas).
// Import creates a whole organisation from a JSON file; that is not a phone
// gesture, and this screen is read-only.
//
// PERF: one FlatList over a flattened tree (org.ts), never a nested render.
//
// TAPPING AN AGENT opens the SAME agent detail the roster pushes (MOB-6b) — the
// web's card is a button that opens the agent too, so the drill-in is the web's,
// not a phone invention.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { AgentAvatar } from '../AgentAvatar'
import { Api } from '../api'
import { useAuth } from '../auth'
import {
  ORG_CANVAS_NOTE,
  managerIds,
  orgRows,
  roleLine,
  runtimeLine,
  type OrgAgentLite,
  type OrgRow,
} from '../org'
import { statusIcon, statusTone } from '../status'
import { font, radius, space, theme } from '../theme'
import { Banner, Empty, Loading } from '../ui'
import { AddAgentButton } from './InviteAgentSheet'

const INDENT = 16 // points per reporting level

const TONE_COLOR = {
  ok: theme.green,
  warn: theme.orange,
  danger: theme.vermillion,
  delegate: theme.purple,
  info: theme.blue,
  neutral: theme.textFaint,
} as const

/**
 * One agent. The web's card, minus the geometry: avatar + status, name,
 * title/role, runtime line. The status is glyph + tone + a screen-reader label —
 * never hue alone (the operator is red-green colorblind; see theme.ts).
 */
function AgentRow({ row, onOpen, onToggle }: {
  row: OrgRow<OrgAgentLite>
  onOpen: (id: string, name: string) => void
  onToggle: (id: string) => void
}) {
  const a = row.agent
  const tone = statusTone(a.status)
  return (
    <View style={[s.rowWrap, { marginLeft: row.depth * INDENT }]}>
      {/* The tree rail: a hairline standing in for the web's edges, so depth
          reads as structure and not just as an accident of margin. */}
      {row.depth > 0 ? <View style={s.rail} /> : null}

      {/* The caret is its own target — folding a branch must not open an agent. */}
      <Pressable
        onPress={row.hasChildren ? () => onToggle(a.id) : undefined}
        accessibilityRole={row.hasChildren ? 'button' : undefined}
        accessibilityState={row.hasChildren ? { expanded: row.expanded } : undefined}
        accessibilityLabel={
          row.hasChildren
            ? `${row.expanded ? 'Collapse' : 'Expand'} ${a.name}'s ${row.childCount} report${row.childCount === 1 ? '' : 's'}`
            : undefined
        }
        style={s.caretHit}
      >
        <Text style={s.caret}>{row.hasChildren ? (row.expanded ? '▾' : '▸') : '·'}</Text>
      </Pressable>

      <Pressable
        onPress={() => onOpen(a.id, a.name)}
        accessibilityRole="button"
        accessibilityLabel={`${a.name}, ${roleLine(a)}. Status ${a.status ?? 'unknown'}. Open agent.`}
        style={({ pressed }) => [s.card, { opacity: pressed ? 0.7 : 1 }]}
      >
        {/* MOB-7c — the agent's picture on the node, as the web's OrgChart nodes
            show it (their AgentAvatar, size 36). */}
        <AgentAvatar agent={a} size={32} />
        <View style={s.body}>
          <View style={s.nameRow}>
            <Text style={s.name} numberOfLines={1}>
              {a.name}
            </Text>
            {/* Glyph carries the status; the colour only decorates it. */}
            <Text style={[s.status, { color: TONE_COLOR[tone] }]}>{statusIcon(a.status)}</Text>
          </View>
          <Text style={s.role} numberOfLines={1}>
            {roleLine(a)}
          </Text>
          <Text style={s.runtime} numberOfLines={1}>
            {runtimeLine(a)}
          </Text>
          {/* A collapsed manager must still say what it's hiding. */}
          {row.hasChildren && !row.expanded ? (
            <Text style={s.reports}>
              {row.childCount} direct report{row.childCount === 1 ? '' : 's'} hidden
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  )
}

// Props declared inline rather than imported from navigation.tsx: that's the
// convention AgentsScreen/TasksScreen already use, and it keeps the screen free
// of a navigation import (and of the import cycle one would create).
export default function OrgScreen({ onOpenAgent }: { onOpenAgent?: (id: string, name?: string) => void }) {
  const { apiUrl, getToken, orgId } = useAuth()
  const [agents, setAgents] = useState<OrgAgentLite[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      setAgents(await Api.orgchart(apiUrl, token, orgId))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the org chart.')
      setAgents([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(() => (agents ? orgRows(agents, collapsed) : []), [agents, collapsed])
  const managers = useMemo(() => (agents ? managerIds(agents) : []), [agents])
  const allCollapsed = managers.length > 0 && managers.every((id) => collapsed.has(id))

  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])

  const openAgent = useCallback(
    (id: string, name: string) => onOpenAgent?.(id, name),
    [onOpenAgent],
  )

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.agent.id}
      renderItem={({ item }) => <AgentRow row={item} onOpen={openAgent} onToggle={toggle} />}
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={agents === null} onRefresh={load} tintColor={theme.blue} />
      }
      ListHeaderComponent={
        <View>
          {error ? (
            <View style={{ marginBottom: space.md }}>
              <Banner kind="error">{error}</Banner>
            </View>
          ) : null}
          {agents === null ? <Loading text="Loading the org chart…" /> : null}
          {/* AAD-2 — the "+ Agent" entry point. The desk's Org section had no add
              affordance either (its toolbar was Import/Export/zoom only); both
              surfaces get one in the same wave. Owner-gated inside the button. */}
          <View style={{ marginBottom: space.md }}>
            <AddAgentButton />
          </View>
          {rows.length ? (
            <View style={s.head}>
              <Text style={s.count}>
                {agents?.length} agent{agents?.length === 1 ? '' : 's'}
              </Text>
              {managers.length ? (
                <Pressable
                  onPress={() => setCollapsed(allCollapsed ? new Set() : new Set(managers))}
                  accessibilityRole="button"
                  style={s.foldHit}
                >
                  <Text style={s.fold}>{allCollapsed ? 'Expand all' : 'Collapse all'}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        agents !== null && !error ? (
          // The web's empty state, same promise.
          <Empty text="No agents yet — hire one and the reporting tree appears here." />
        ) : null
      }
      ListFooterComponent={
        rows.length ? <Text style={s.note}>{ORG_CANVAS_NOTE}</Text> : null
      }
    />
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  count: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  foldHit: { minHeight: 44, justifyContent: 'center', paddingLeft: space.md },
  fold: { color: theme.blue, fontSize: font.sm, fontWeight: '700' },
  rowWrap: { flexDirection: 'row', alignItems: 'stretch', marginBottom: space.sm },
  rail: { width: 1, backgroundColor: theme.s3, marginRight: space.sm },
  caretHit: { width: 28, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  caret: { color: theme.textDim, fontSize: font.base },
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    backgroundColor: theme.s1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: theme.s3,
    padding: space.md,
    minHeight: 44,
  },
  body: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { color: theme.text, fontSize: font.base, fontWeight: '700', flexShrink: 1 },
  status: { fontSize: font.base, fontWeight: '700' },
  role: { color: theme.textDim, fontSize: font.sm, marginTop: 1 },
  runtime: { color: theme.textFaint, fontSize: font.sm - 1, marginTop: 2 },
  reports: { color: theme.blue, fontSize: font.sm - 1, marginTop: space.xs, fontWeight: '600' },
  note: { color: theme.textFaint, fontSize: font.sm - 1, marginTop: space.xl, lineHeight: 18 },
})
