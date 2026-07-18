// MEM-1 — Memory · Links. The phone's peer to the web's ⬡ Graph view.
//
// The desk draws `…/memory/graph` as a d3-force canvas. This renders the SAME
// payload as lists, because the two things a force map is actually FOR are both
// list-shaped once you take the canvas away:
//
//   FIND a note anywhere in the vault. The folder tree cannot do this — it
//   fetches one directory per call, so it can only search what you already
//   opened. The graph payload names every note at once, so search here is
//   client-side, instant, and complete.
//
//   WALK the links. Tap a note and you get what it links to and what links back
//   to it; tap one of those and you're standing there instead, with a trail to
//   come back along. That is what panning a graph is for, minus the pinching.
//
// Why not an actual canvas — hit-testing at 44pt and the single JS thread —
// is argued in full in src/vaultGraph.ts. react-native-svg IS bundled in Expo
// Go, so the renderer was never the blocker.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import { font, radius, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'
import {
  GRAPH_TREATMENT_NOTE,
  buildIndex,
  connectivityLabel,
  neighboursOf,
  nodeGlyph,
  searchNotes,
  topHubs,
  type GraphLite,
  type NoteNode,
} from '../vaultGraph'

/** One tappable node row — the list's equivalent of a circle on the desk. */
function NodeRow({
  node,
  detail,
  onPress,
}: {
  node: NoteNode
  detail: string
  onPress: (n: NoteNode) => void
}) {
  return (
    <Pressable
      onPress={() => onPress(node)}
      accessibilityRole="button"
      accessibilityLabel={`${node.kind === 'tag' ? 'Tag' : 'Note'} ${node.label}, ${detail}`}
      style={({ pressed }) => [s.row, { opacity: pressed ? 0.6 : 1 }]}
    >
      {/* Kind is a GLYPH, never a hue — the colourblind rule, same as the tree. */}
      <Text style={s.glyph}>{nodeGlyph(node)}</Text>
      <View style={s.rowBody}>
        <Text style={s.rowLabel} numberOfLines={1}>
          {node.label}
        </Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Text style={s.chevron}>›</Text>
    </Pressable>
  )
}

export default function MemoryConnections({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const { apiUrl, getToken, orgId } = useAuth()
  const [graph, setGraph] = useState<GraphLite | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** The traversal trail. Last entry is where you're standing; [] is the index. */
  const [trail, setTrail] = useState<string[]>([])

  const load = useCallback(
    async (rebuild = false) => {
      setLoading(true)
      try {
        const token = await getToken()
        if (!token || !orgId) return
        setGraph(await Api.memoryGraph(apiUrl, token, orgId, { rebuild }))
        setError(null)
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load the vault links.')
      } finally {
        setLoading(false)
      }
    },
    [apiUrl, getToken, orgId],
  )

  useEffect(() => {
    load()
  }, [load])

  const index = useMemo(
    () => buildIndex(graph?.nodes ?? [], graph?.edges ?? []),
    [graph],
  )

  const currentId = trail.length ? trail[trail.length - 1] : null
  const current = currentId ? index.byId.get(currentId) ?? null : null
  const hood = useMemo(
    () => (currentId ? neighboursOf(index, currentId) : null),
    [index, currentId],
  )

  // Standing on a node: push it on the trail. Searching from a node: the trail
  // is irrelevant, so typing clears it (below) rather than stacking under it.
  const visit = useCallback((n: NoteNode) => {
    setTrail(t => [...t, n.id])
  }, [])
  const back = useCallback(() => setTrail(t => t.slice(0, -1)), [])

  const results = useMemo(
    () => (query.trim() ? searchNotes(graph?.nodes ?? [], query) : []),
    [graph, query],
  )
  const hubs = useMemo(() => topHubs(graph?.nodes ?? [], 40), [graph])

  // ── The detail view: one node and its neighbourhood ───────────────────────
  if (current && hood) {
    const sections: { title: string; data: NoteNode[] }[] = [
      { title: `Links to (${hood.links.length})`, data: hood.links },
      { title: `Linked from (${hood.backlinks.length})`, data: hood.backlinks },
    ]
    return (
      <FlatList
        data={sections.flatMap(sec => [{ header: sec.title } as const, ...sec.data])}
        keyExtractor={(item, i) => ('header' in item ? `h${i}` : `${item.id}${i}`)}
        contentContainerStyle={s.wrap}
        renderItem={({ item }) =>
          'header' in item ? (
            <Text style={s.sectionTitle}>{item.header}</Text>
          ) : (
            <NodeRow node={item} detail={connectivityLabel(index, item.id)} onPress={visit} />
          )
        }
        ListHeaderComponent={
          <View>
            <Pressable onPress={back} accessibilityRole="button" style={s.backRow}>
              <Text style={s.back}>‹ {trail.length > 1 ? 'Back' : 'All notes'}</Text>
            </Pressable>
            <Card style={s.detailCard}>
              <Text style={s.detailTitle}>{current.label}</Text>
              <Text style={s.detailMeta}>
                {current.group} · {connectivityLabel(index, current.id)}
              </Text>
              {current.communityName ? (
                <Text style={s.concept}>◇ {current.communityName}</Text>
              ) : null}
              {hood.tags.length ? (
                <View style={s.tagRow}>
                  {hood.tags.map(t => (
                    <Pressable key={t.id} onPress={() => visit(t)} accessibilityRole="button">
                      <Chip label={t.label} tone="neutral" />
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {/* A tag and a heading have no markdown of their own to open — the
                  button only appears when there is genuinely a note behind it. */}
              {current.path ? (
                <Pressable
                  onPress={() => onOpenNote(current.path!)}
                  accessibilityRole="button"
                  style={({ pressed }) => [s.openBtn, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Text style={s.openBtnText}>📄 Open note</Text>
                </Pressable>
              ) : null}
            </Card>
          </View>
        }
        ListFooterComponent={
          !hood.links.length && !hood.backlinks.length ? (
            <Empty text="This note has no links yet — nothing points here, and it points nowhere." />
          ) : null
        }
      />
    )
  }

  // ── The index view: search, or the vault's hubs ───────────────────────────
  const showing = query.trim() ? results : hubs
  return (
    <FlatList
      data={showing}
      keyExtractor={n => n.id}
      contentContainerStyle={s.wrap}
      refreshControl={
        /* Refetch, NOT `load(true)`. `?rebuild=1` busts the server's 10-minute
           cache and re-crawls the vault — up to one GitHub call per note on the
           native path. The web binds that to a deliberate ↻ Rebuild button; on a
           phone the same cost must not hang off the most accidental gesture
           there is. Pull-to-refresh re-reads; it doesn't rebuild. */
        <RefreshControl refreshing={loading} onRefresh={() => load(false)} tintColor={theme.blue} />
      }
      renderItem={({ item }) => (
        <NodeRow node={item} detail={connectivityLabel(index, item.id)} onPress={visit} />
      )}
      ListHeaderComponent={
        <View>
          <TextInput
            value={query}
            onChangeText={t => {
              setQuery(t)
              setTrail([])
            }}
            placeholder="Search the whole vault…"
            placeholderTextColor={theme.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search notes across the vault"
            style={s.search}
          />
          {error ? (
            <View style={{ marginBottom: space.md }}>
              <Banner kind="error">{error}</Banner>
            </View>
          ) : null}
          {loading && !graph ? <Loading text="Reading the vault links…" /> : null}
          {graph ? (
            <Text style={s.stats}>
              {query.trim()
                ? `${results.length} match${results.length === 1 ? '' : 'es'}`
                : `Most connected · ${graph.stats.notes} notes · ${graph.stats.links} links`}
              {graph.source === 'graphify' ? ' · ⬡ Graphify' : ' · ◇ native parse'}
            </Text>
          ) : null}
          {/* A partial vault must say it is partial — same rule as the desk. */}
          {graph?.stats.capped ? (
            <Text style={s.capped}>
              Showing the {graph.nodes.length} most-connected of {graph.stats.totalNodes} — the
              rest are still browsable in Vault.
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        !loading && graph ? (
          <Empty
            text={
              query.trim()
                ? `No note matches “${query.trim()}”.`
                : 'No links found yet — this vault has no [[wikilinks]] between its notes.'
            }
          />
        ) : null
      }
      ListFooterComponent={
        showing.length ? (
          <View style={s.footer}>
            <Text style={s.note}>{GRAPH_TREATMENT_NOTE}</Text>
          </View>
        ) : null
      }
    />
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  search: {
    backgroundColor: theme.s2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: theme.s3,
    color: theme.text,
    fontSize: font.base,
    paddingHorizontal: space.md,
    // 44pt is the iOS minimum touch target.
    minHeight: 44,
    marginBottom: space.md,
  },
  stats: { color: theme.textDim, fontSize: font.sm, marginBottom: space.sm },
  capped: { color: theme.textFaint, fontSize: font.sm, marginBottom: space.sm, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    minHeight: 44,
  },
  glyph: { fontSize: font.base, color: theme.textDim, width: 22, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowLabel: { color: theme.text, fontSize: font.base },
  rowMeta: { color: theme.textFaint, fontSize: font.sm, marginTop: 1 },
  chevron: { color: theme.textFaint, fontSize: font.lg },
  sectionTitle: {
    color: theme.textDim,
    fontSize: font.sm,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginTop: space.lg,
    marginBottom: space.xs,
    textTransform: 'uppercase',
  },
  // detail
  backRow: { minHeight: 44, justifyContent: 'center' },
  back: { color: theme.blue, fontSize: font.base, fontWeight: '700' },
  detailCard: { marginBottom: space.sm },
  detailTitle: { color: theme.text, fontSize: font.lg, fontWeight: '800' },
  detailMeta: { color: theme.textDim, fontSize: font.sm, marginTop: 2 },
  concept: { color: theme.purple, fontSize: font.sm, marginTop: space.xs },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm },
  openBtn: {
    marginTop: space.md,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: theme.blue,
  },
  openBtnText: { color: theme.blue, fontSize: font.base, fontWeight: '700' },
  footer: { marginTop: space.xl },
  note: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 18 },
})
