// MOB-6e — Memory. Read-only, replacing the `memory` placeholder.
//
// MIRRORS the web's `memory` tab (web/app/dashboard/MemoryPanel.tsx) over the
// same two calls:
//
//   GET /api/orgs/:orgId/memory/tree?path=  → one directory's entries
//   GET /api/orgs/:orgId/memory/file?path=  → one note's markdown
//
// THE SHAPE, AND WHY IT DIFFERS. The web is two panes: a folder list beside a
// reader, where clicking a folder REPLACES the list with that folder's contents
// and a breadcrumb walks you back. On a phone that trade is bad — replacing the
// whole screen to peek inside a folder costs you the context you opened it for.
// So the tree here is COLLAPSIBLE: expanding splices children in beneath their
// folder and the rest of the vault stays put. Tapping a note opens the reader as
// a pushed sheet, so the back gesture returns you to the tree exactly where you
// left it. Same endpoints, same entries, same order — a different traversal.
//
// WHAT'S DROPPED: the web's ⬡ Graph CANVAS (VaultGraph.tsx — a d3-force
// simulation over `…/memory/graph`). A force-directed map of a whole vault is a
// canvas-and-pointer artefact; at 390pt it's a hairball. DROPPED, not deferred —
// parity doc §6.6, re-affirmed by MEM-1 (reasons in src/vaultGraph.ts).
//
// WHAT MEM-1 ADDED: the graph's DATA, as the Links tab (MemoryConnections.tsx).
// The canvas stays dropped; what it was FOR — finding a note anywhere in the
// vault, and walking what links to what — is list-shaped and now here. So this
// screen is two views over the same vault, mirroring the web's own
// 📄 Reader / ⬡ Graph toggle: 🗂 Vault (the tree) and 🔗 Links (the graph).
//
// ALSO DROPPED: the vault PICKER ("Change vault…" — a PUT to
// `…/connectors/obsidian/config`). This screen is read-only, and repointing the
// org's shared vault from a phone is a config change with an org-wide blast
// radius. The vault IS labelled, from the tree response, so you always know what
// you're reading.
//
// PERF: one FlatList over a flattened tree (memory.ts), never a nested render —
// so a deep vault costs what's on screen, not what's in the repo.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import {
  MEMORY_GRAPH_NOTE,
  UNREADABLE_NOTE,
  VAULT_DEFAULT,
  baseName,
  breadcrumb,
  entryGlyph,
  flattenTree,
  isNotePath,
  parseMarkdown,
  type Block,
  type Inline,
  type TreeRow,
  type VaultCfgLite,
  type VaultDirs,
} from '../memory'
import { font, radius, space, theme } from '../theme'
import { Banner, Card, Empty, Loading } from '../ui'
import MemoryConnections from './MemoryConnections'

const INDENT = 14 // points per depth level

// ─── The reader ──────────────────────────────────────────────────────────────

/** One inline span. Renders as <Text>, so vault content can never be markup. */
function Span({ span }: { span: Inline }) {
  if (span.kind === 'code') return <Text style={r.code}>{span.text}</Text>
  if (span.kind === 'strong') return <Text style={r.strong}>{span.text}</Text>
  if (span.kind === 'em') return <Text style={r.em}>{span.text}</Text>
  // A [[wikilink]] is styled but NOT tappable: resolving one means searching the
  // vault for a title, which is a feature (the web doesn't do it either — it
  // renders a <span>). A link that looks tappable and isn't is worse than one
  // that doesn't pretend.
  if (span.kind === 'wikilink') return <Text style={r.wikilink}>{span.text}</Text>
  // An external link is shown in link colour but not opened: this screen is
  // read-only and opening a URL from untrusted note content is a different
  // decision than reading it. The href is printed so it's inspectable.
  if (span.kind === 'link') return <Text style={r.link}>{span.text}</Text>
  return <Text>{span.text}</Text>
}

function Line({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <Span key={i} span={s} />
      ))}
    </>
  )
}

function MdBlock({ block }: { block: Block }) {
  if (block.kind === 'hr') return <View style={r.hr} />
  if (block.kind === 'code')
    return (
      <Text style={r.codeBlock}>
        <Line spans={block.spans} />
      </Text>
    )
  if (block.kind === 'li')
    return (
      <View style={r.liRow}>
        <Text style={r.bullet}>•</Text>
        <Text style={r.p}>
          <Line spans={block.spans} />
        </Text>
      </View>
    )
  const style =
    block.kind === 'h1' ? r.h1 : block.kind === 'h2' ? r.h2 : block.kind === 'h3' ? r.h3 : block.kind === 'h4' ? r.h4 : r.p
  return (
    <Text style={style}>
      <Line spans={block.spans} />
    </Text>
  )
}

/** The note reader — the web's right-hand pane, as a pushed sheet. */
function NoteReader({
  path,
  markdown,
  loading,
  error,
  onBack,
}: {
  path: string
  markdown: string | null
  loading: boolean
  error: string | null
  onBack: () => void
}) {
  const blocks = useMemo(() => (markdown ? parseMarkdown(markdown) : []), [markdown])
  return (
    <View style={s.fill}>
      <Pressable onPress={onBack} accessibilityRole="button" style={s.backRow}>
        <Text style={s.back}>‹ Vault</Text>
      </Pressable>
      <ScrollView contentContainerStyle={s.readerWrap}>
        <Text style={s.noteTitle}>{baseName(path)}</Text>
        <Text style={s.crumbs}>{breadcrumb(path)}</Text>
        {error ? <Banner kind="error">{error}</Banner> : null}
        {loading ? <Loading text="Opening note…" /> : null}
        {!loading && !error && blocks.length === 0 ? <Empty text="This note is empty." /> : null}
        {blocks.map((b, i) => (
          <MdBlock key={i} block={b} />
        ))}
      </ScrollView>
    </View>
  )
}

// ─── The tree ────────────────────────────────────────────────────────────────

function Row({ row, onPress }: { row: TreeRow; onPress: (row: TreeRow) => void }) {
  const isDir = row.entry.type === 'dir'
  const readable = isDir || isNotePath(row.entry.path)
  return (
    <Pressable
      onPress={readable ? () => onPress(row) : undefined}
      accessibilityRole="button"
      accessibilityState={isDir ? { expanded: row.expanded } : undefined}
      // The glyph is decoration; the label + state carry the meaning.
      accessibilityLabel={`${isDir ? 'Folder' : 'Note'} ${row.entry.name}${readable ? '' : ' — not readable'}`}
      style={({ pressed }) => [
        s.row,
        { paddingLeft: space.lg + row.depth * INDENT, opacity: pressed && readable ? 0.6 : 1 },
      ]}
    >
      <Text style={s.glyph}>{entryGlyph(row)}</Text>
      <Text style={[s.name, !readable && s.nameDim]} numberOfLines={1}>
        {row.entry.name}
      </Text>
      {row.loading ? <Text style={s.rowNote}>…</Text> : null}
      {!readable ? <Text style={s.rowNote}>—</Text> : null}
    </Pressable>
  )
}

export default function MemoryScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  // 🗂 Vault (the tree) ⇄ 🔗 Links (the graph's data). The web's own toggle is
  // 📄 Reader ⇄ ⬡ Graph over the same two datasets.
  const [view, setView] = useState<'vault' | 'links'>('vault')
  const [cfg, setCfg] = useState<VaultCfgLite>(VAULT_DEFAULT)
  const [dirs, setDirs] = useState<VaultDirs>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [rootLoaded, setRootLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The open note. `null` = the tree is showing.
  const [note, setNote] = useState<{ path: string; markdown: string | null } | null>(null)
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)

  const root = cfg.root || VAULT_DEFAULT.root

  /** Fetch one directory. The tree grows as folders open — never all at once. */
  const loadDir = useCallback(
    async (path: string) => {
      const token = await getToken()
      if (!token || !orgId) return
      setLoadingPaths((p) => new Set(p).add(path))
      try {
        const r = await Api.memoryTree(apiUrl, token, orgId, path)
        // The response says which vault answered — so the label can't disagree
        // with the tree it's labelling.
        if (r.repo) setCfg({ repo: r.repo, root: r.root, branch: r.branch })
        setDirs((d) => ({ ...d, [path]: r.entries ?? [] }))
        setError(null)
      } catch (e: any) {
        // One folder failing must not blank the tree the operator is standing in.
        // Say what failed, keep what loaded, and leave the folder closed.
        setError(e?.message ?? 'Failed to load the vault.')
        setExpanded((x) => {
          const n = new Set(x)
          n.delete(path)
          return n
        })
      } finally {
        setLoadingPaths((p) => {
          const n = new Set(p)
          n.delete(path)
          return n
        })
      }
    },
    [apiUrl, getToken, orgId],
  )

  const loadRoot = useCallback(async () => {
    setRootLoaded(false)
    await loadDir(root)
    setRootLoaded(true)
  }, [loadDir, root])

  useEffect(() => {
    loadRoot()
    // Only on mount / identity change: re-running on every `root` change would
    // refetch the moment the response tells us the root, which is the same fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, orgId])

  /**
   * Open a note in the reader. Shared by the tree (tap a file) and the Links
   * view (tap "Open note"), so both land in the SAME reader with the same
   * loading and error handling — one note-opening path, not two that drift.
   */
  const openNotePath = useCallback(
    (path: string) => {
      setNote({ path, markdown: null })
      setNoteError(null)
      setNoteLoading(true)
      ;(async () => {
        try {
          const token = await getToken()
          if (!token || !orgId) return
          const r = await Api.memoryFile(apiUrl, token, orgId, path)
          setNote({ path, markdown: r.markdown ?? '' })
        } catch (e: any) {
          setNoteError(e?.message ?? 'Failed to open the note.')
        } finally {
          setNoteLoading(false)
        }
      })()
    },
    [apiUrl, getToken, orgId],
  )

  const onPressRow = useCallback(
    (row: TreeRow) => {
      if (row.entry.type === 'dir') {
        const path = row.entry.path
        const willExpand = !expanded.has(path)
        // The updater stays PURE — it computes the next set and nothing else.
        // A state updater must be safe to call twice: React StrictMode
        // deliberately double-invokes it, so a fetch in here would issue two GETs
        // per folder open (and, on a slow network, two writes racing into `dirs`).
        // The side effect belongs to the EVENT, not to the state transition.
        setExpanded((x) => {
          const n = new Set(x)
          if (willExpand) n.add(path)
          else n.delete(path)
          return n
        })
        // Fetch on FIRST open only — a folder already fetched reopens instantly,
        // and a closed subtree is never re-walked.
        if (willExpand && dirs[path] === undefined) loadDir(path)
        return
      }
      // A note. `isNotePath` already gated the tap (the row isn't pressable
      // otherwise), so this only ever asks for a path the backend will serve.
      openNotePath(row.entry.path)
    },
    // `expanded` is read to decide the toggle direction, so it belongs here: a
    // stale closure would flip the wrong way and, worse, mis-decide the fetch.
    [dirs, expanded, loadDir, openNotePath],
  )

  const rows = useMemo(
    () => flattenTree(dirs, root, expanded, loadingPaths),
    [dirs, root, expanded, loadingPaths],
  )

  if (note) {
    return (
      <NoteReader
        path={note.path}
        markdown={note.markdown}
        loading={noteLoading}
        error={noteError}
        onBack={() => setNote(null)}
      />
    )
  }

  // The view switch sits ABOVE both views so it never scrolls away — on a phone
  // a toggle you have to scroll back up to reach is a toggle you stop using.
  const Switcher = (
    <View style={s.seg} accessibilityRole="tablist">
      {(['vault', 'links'] as const).map((v) => {
        const on = view === v
        return (
          <Pressable
            key={v}
            onPress={() => setView(v)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[s.segBtn, on && s.segOn]}
          >
            <Text style={[s.segText, on && s.segTextOn]}>
              {v === 'vault' ? '🗂 Vault' : '🔗 Links'}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )

  if (view === 'links') {
    return (
      <View style={s.fill}>
        {Switcher}
        <MemoryConnections onOpenNote={openNotePath} />
      </View>
    )
  }

  return (
    <View style={s.fill}>
      {Switcher}
      <FlatList
      data={rows}
      keyExtractor={(row) => row.entry.path}
      renderItem={({ item }) => <Row row={item} onPress={onPressRow} />}
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl
          refreshing={!rootLoaded && loadingPaths.has(root)}
          onRefresh={() => {
            // A refresh re-reads what's OPEN, not the whole vault: collapsing the
            // tree under someone who pulled to refresh would lose their place.
            setDirs({})
            loadRoot()
            for (const p of expanded) loadDir(p)
          }}
          tintColor={theme.blue}
        />
      }
      ListHeaderComponent={
        <View>
          {/* Which vault this is. From the response, never assumed. */}
          <Card style={s.vault}>
            <Text style={s.vaultLabel}>VAULT</Text>
            <Text style={s.vaultVal} numberOfLines={1}>
              {cfg.repo}
            </Text>
            <Text style={s.vaultMeta}>
              {cfg.root}/ · {cfg.branch}
            </Text>
          </Card>
          {error ? (
            <View style={{ marginBottom: space.md }}>
              <Banner kind="error">{error}</Banner>
            </View>
          ) : null}
          {!rootLoaded && !error ? <Loading text="Loading the vault…" /> : null}
        </View>
      }
      ListEmptyComponent={
        rootLoaded && !error ? (
          <Empty
            text={
              // A vault with no token and a vault with no notes are different
              // problems; the backend's own message covers the first (it lands in
              // the banner above), so this only speaks to the second.
              'This vault is empty — no notes at its root.'
            }
          />
        ) : null
      }
      ListFooterComponent={
        rows.length ? (
          <View style={s.footer}>
            <Text style={s.note}>{MEMORY_GRAPH_NOTE}</Text>
            <Text style={s.note}>{UNREADABLE_NOTE}</Text>
          </View>
        ) : null
      }
      />
    </View>
  )
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  wrap: { padding: space.lg },
  // 🗂 Vault ⇄ 🔗 Links. The active tab is carried by BOTH a fill and the
  // text weight/colour, never by hue alone.
  seg: {
    flexDirection: 'row',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: 3,
    backgroundColor: theme.s1,
    borderRadius: radius.sm,
  },
  segBtn: { flex: 1, minHeight: 40, justifyContent: 'center', alignItems: 'center', borderRadius: radius.sm - 2 },
  segOn: { backgroundColor: theme.s3 },
  segText: { color: theme.textDim, fontSize: font.sm },
  segTextOn: { color: theme.text, fontWeight: '700' },
  vault: { marginBottom: space.md },
  vaultLabel: { color: theme.textFaint, fontSize: font.sm - 2, fontWeight: '700', letterSpacing: 0.6 },
  vaultVal: { color: theme.text, fontSize: font.base, fontWeight: '700', marginTop: 2 },
  vaultMeta: { color: theme.textDim, fontSize: font.sm, marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingRight: space.lg,
    borderRadius: radius.sm,
    // 44pt is the iOS minimum touch target — a tree row is small, not tiny.
    minHeight: 44,
  },
  glyph: { fontSize: font.base, color: theme.textDim, width: 20, textAlign: 'center' },
  name: { color: theme.text, fontSize: font.base, flex: 1 },
  nameDim: { color: theme.textFaint },
  rowNote: { color: theme.textFaint, fontSize: font.sm },
  footer: { marginTop: space.xl, gap: space.sm },
  note: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 18 },
  // reader
  backRow: { paddingHorizontal: space.lg, paddingTop: space.md, minHeight: 44, justifyContent: 'center' },
  back: { color: theme.blue, fontSize: font.base, fontWeight: '700' },
  readerWrap: { padding: space.lg, paddingBottom: space.xxl },
  noteTitle: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  crumbs: { color: theme.textFaint, fontSize: font.sm, marginTop: 2, marginBottom: space.lg },
})

const r = StyleSheet.create({
  h1: { color: theme.text, fontSize: font.xl, fontWeight: '800', marginTop: space.lg, marginBottom: space.sm },
  h2: { color: theme.text, fontSize: font.lg, fontWeight: '800', marginTop: space.lg, marginBottom: space.sm },
  h3: { color: theme.text, fontSize: font.base + 1, fontWeight: '700', marginTop: space.md, marginBottom: space.xs },
  h4: { color: theme.textDim, fontSize: font.base, fontWeight: '700', marginTop: space.md, marginBottom: space.xs },
  p: { color: theme.textDim, fontSize: font.base, lineHeight: 23, marginBottom: space.sm },
  liRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.xs, paddingLeft: space.sm },
  bullet: { color: theme.textFaint, fontSize: font.base, lineHeight: 23 },
  strong: { color: theme.text, fontWeight: '700' },
  em: { fontStyle: 'italic' },
  code: { color: theme.blue, fontFamily: 'Menlo', fontSize: font.sm },
  codeBlock: {
    color: theme.textDim,
    fontFamily: 'Menlo',
    fontSize: font.sm - 1,
    backgroundColor: theme.s1,
    paddingHorizontal: space.md,
    paddingVertical: 2,
    lineHeight: 19,
  },
  link: { color: theme.blue },
  // The vault's own cross-references — Obsidian's [[wikilinks]].
  wikilink: { color: theme.purple },
  hr: { height: 1, backgroundColor: theme.s3, marginVertical: space.lg },
})
