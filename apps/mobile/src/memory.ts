// MOB-6e — the vault reader's pure half. No React, no react-native, so
// `memory.test.ts` can load it (and the BACKEND's vault-connector) under
// `node --test` and assert the two still agree.
//
// WHAT THE WEB DOES, AND WHAT THE PHONE DOES INSTEAD
//
// The web's Memory tab (web/app/dashboard/MemoryPanel.tsx) is two panes: a
// folder list on the left, rendered markdown on the right. Its tree is a
// SINGLE-LEVEL browser — you're in one directory, you click a folder, the pane
// is replaced by that folder's contents, and a breadcrumb walks you back. That's
// a fine shape for a 280px column beside a reader; it's a bad one for a phone,
// where replacing the whole screen to see what's inside a folder loses the
// context you opened it for.
//
// So the phone renders the vault as ONE COLLAPSIBLE TREE: expanding a folder
// splices its children in beneath it, at a deeper indent, and the rest of the
// vault stays put. Same endpoint, same entries, same order — a different
// traversal of the same data, which is the trade §6.6 of the parity doc records.
//
// WHY THE TREE IS BUILT INCREMENTALLY: `GET …/memory/tree?path=` returns ONE
// directory's entries (it's a GitHub Contents call per folder, backend
// services/vault-connector.ts). There is no whole-vault endpoint. So expanding a
// folder is a fetch, and this module models the tree as a flat map of
// path → children that the screen fills in as the operator opens things. That
// also means we never fetch the vault we aren't looking at — on a phone network,
// that's the difference between a screen and a stall.
//
// THE FORCE GRAPH IS NOT HERE, ON PURPOSE. The web's other Memory view is
// VaultGraph.tsx: a d3-force simulation over `…/memory/graph`. It is dropped,
// not deferred — see MEMORY_GRAPH_NOTE below and the parity doc §6.6.

/** One vault entry, verbatim from the backend's `VaultEntry`. */
export type VaultEntryLite = { name: string; path: string; type: 'dir' | 'file' }

/** The vault the reader is pointed at — the web's `VaultCfg`, same fields. */
export type VaultCfgLite = { repo: string; root: string; branch: string }

/**
 * The web's default vault, mirrored from the backend's `defaultVaultConfig()`.
 * The phone does NOT read `…/connectors/obsidian/config` the way the web does:
 * that endpoint also backs the web's "Change vault…" editor, and the phone is
 * read-only, so it asks the backend for the tree and lets the RESPONSE say which
 * vault answered — `/memory/tree` echoes `repo`/`root`/`branch` back (see the
 * route in backend/src/routes/tasks.ts). One less call, and the label can't
 * disagree with the tree it's labelling.
 */
export const VAULT_DEFAULT: VaultCfgLite = {
  repo: 'Arturito7ei/7Ei-MC_TARCO',
  root: 'vault',
  branch: 'main',
}

/**
 * Why the graph's CANVAS has no phone peer — and where its data went instead.
 *
 * MOB-6e dropped the graph outright. MEM-1 kept the canvas dropped (the reasons
 * are unchanged and argued in vaultGraph.ts) but brought the DATA across as the
 * Links tab, so this no longer says "the vault itself is all here" as if link
 * structure weren't part of the vault. It is; it's one tab over.
 */
export const MEMORY_GRAPH_NOTE =
  'The force-directed map stays on the desktop — it needs a canvas and a pointer to be worth anything. The links themselves are here: switch to Links to search the whole vault and walk what connects to what.'

/** Why a non-markdown file has no reader. */
export const UNREADABLE_NOTE =
  'Only notes (.md, .markdown, .txt) can be opened here.'

// ─── Path rules — mirrored from the backend, pinned by memory.test.ts ─────────

/**
 * Is this a note the reader can open? A verbatim mirror of the backend's
 * `isMarkdownPath` (services/vault-connector.ts).
 *
 * Mirrored rather than trusted-at-runtime because the phone must decide BEFORE
 * it calls: `/memory/file` 400s on a non-markdown path, and an error banner
 * saying "invalid path" is a worse answer to "why can't I open this PNG" than
 * simply not offering it as tappable. The tripwire pins the two together, so a
 * new extension on the server can't leave the phone refusing files the desk opens.
 */
export function isNotePath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(String(path ?? ''))
}

/**
 * Is this path inside the vault root? Mirror of the backend's `isSafeVaultPath`.
 * The phone only ever walks paths the backend just handed it, so this is a
 * belt-and-braces check on the ONE path we synthesise ourselves (the initial
 * root) — and a tripwire anchor for the traversal rule.
 */
export function isSafeVaultPath(path: string, root: string): boolean {
  const p = String(path ?? '').replace(/^\/+/, '')
  if (p.includes('..') || p.includes('\\')) return false
  const r = String(root ?? '').replace(/^\/+|\/+$/g, '')
  return p === r || p.startsWith(r + '/') || p === ''
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * Folders first, then files, each A–Z (case-insensitive).
 *
 * The web renders `entries` in the order GitHub returns them, which is already
 * dirs-then-files A–Z for the Contents API — so this SORTS to the order the web
 * SHOWS, rather than depending on a remote API's undocumented default holding.
 * The two agree today; this makes them agree on purpose.
 */
export function sortEntries(entries: VaultEntryLite[]): VaultEntryLite[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

// ─── The flattened tree ──────────────────────────────────────────────────────

/**
 * What the screen holds: every directory we've fetched, keyed by its path.
 * `undefined` = never opened; `[]` = opened and genuinely empty.
 */
export type VaultDirs = Record<string, VaultEntryLite[] | undefined>

/** One rendered row — a FlatList item, not a nested component. */
export type TreeRow = {
  entry: VaultEntryLite
  /** 0 for the root's own children; +1 per folder opened above it. */
  depth: number
  expanded: boolean
  /** A dir that's open but whose children haven't landed yet. */
  loading: boolean
}

/**
 * Walk the expanded set into a FLAT list of rows.
 *
 * Flat on purpose: a vault is arbitrarily deep, and a nested render would build
 * one React subtree per folder and re-render the lot whenever any node toggles.
 * A flat array feeds FlatList, which recycles rows and only ever mounts what's on
 * screen — so a 2,000-note vault scrolls the same as a 20-note one. Depth becomes
 * indentation (a number), not nesting (a component).
 *
 * Only expanded folders contribute children, so this is O(visible), not O(vault).
 */
export function flattenTree(
  dirs: VaultDirs,
  rootPath: string,
  expanded: ReadonlySet<string>,
  loadingPaths: ReadonlySet<string> = new Set(),
): TreeRow[] {
  const rows: TreeRow[] = []
  // A vault is a git tree — it cannot contain a cycle. `seen` guards anyway:
  // this walks data from a remote API, and a bad response must not hang the UI.
  const seen = new Set<string>()

  const walk = (path: string, depth: number) => {
    if (seen.has(path)) return
    seen.add(path)
    for (const entry of sortEntries(dirs[path] ?? [])) {
      const isOpen = entry.type === 'dir' && expanded.has(entry.path)
      rows.push({
        entry,
        depth,
        expanded: isOpen,
        loading: isOpen && dirs[entry.path] === undefined && loadingPaths.has(entry.path),
      })
      if (isOpen) walk(entry.path, depth + 1)
    }
  }
  walk(rootPath, 0)
  return rows
}

/** The glyph for a row. Folders say open/closed; a note that can't be read says so. */
export function entryGlyph(row: TreeRow): string {
  if (row.entry.type === 'dir') return row.expanded ? '▾' : '▸'
  return isNotePath(row.entry.path) ? '📄' : '📎'
}

/** "vault / Protocols / 7Ei_OS" — the trail to the open note. */
export function breadcrumb(path: string): string {
  return String(path ?? '')
    .split('/')
    .filter(Boolean)
    .join(' / ')
}

/** The note's own filename, for the reader's title. */
export function baseName(path: string): string {
  const parts = String(path ?? '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

// ─── Markdown → blocks ───────────────────────────────────────────────────────
//
// The web's `mdToHtml` escapes the markdown and hands the string to
// `dangerouslySetInnerHTML`. React Native has no innerHTML and no DOM, so the
// same subset is parsed into a BLOCK TREE instead and rendered with <Text>. The
// subset is deliberately the web's: heading (h1–h4), list item, fenced code,
// rule, paragraph — plus the inline run (code, bold, italic, link, [[wikilink]]).
//
// A bonus of parsing to data rather than to HTML: there is no escaping step and
// no innerHTML, so vault content cannot inject markup here at all. The web has
// to escape first and get it right; the phone has nowhere for a `<script>` to go
// — it can only ever become a Text string. Note content is UNTRUSTED input (any
// agent with a vault token can write to it), so this matters.

export type InlineKind = 'text' | 'code' | 'strong' | 'em' | 'link' | 'wikilink'
export type Inline = { kind: InlineKind; text: string; href?: string }

export type BlockKind = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'li' | 'code' | 'hr'
export type Block = { kind: BlockKind; spans: Inline[] }

/** Parse one line's inline run. Order mirrors the web's chained replaces. */
export function parseInline(line: string): Inline[] {
  const spans: Inline[] = []
  // One pass, alternation in the web's precedence: `code` first (so markup
  // inside a span of code stays literal, as the web's replace order gives it),
  // then bold before italic (else `**x**` would match the italic rule twice).
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  const push = (kind: InlineKind, text: string, href?: string) => {
    if (text) spans.push(href ? { kind, text, href } : { kind, text })
  }
  while ((m = re.exec(line))) {
    if (m.index > last) push('text', line.slice(last, m.index))
    const tok = m[0]
    if (m[1]) push('code', tok.slice(1, -1))
    else if (m[2]) push('strong', tok.slice(2, -2))
    else if (m[3]) push('em', tok.slice(1, -1))
    else if (m[4]) push('wikilink', tok.slice(2, -2))
    else if (m[5]) {
      const cut = tok.indexOf('](')
      push('link', tok.slice(1, cut), tok.slice(cut + 2, -1))
    }
    last = m.index + tok.length
  }
  if (last < line.length) push('text', line.slice(last))
  return spans.length ? spans : [{ kind: 'text', text: line }]
}

/**
 * Parse a note into blocks. Mirrors the web's `mdToHtml` line loop: fences
 * toggle a code block (whose lines stay literal), `#{1,4}` is a heading,
 * `- `/`* ` is a list item, `---` is a rule, blank lines are dropped, everything
 * else is a paragraph.
 */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = []
  let inCode = false
  for (const raw of String(md ?? '').split('\n')) {
    if (/^```/.test(raw)) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      blocks.push({ kind: 'code', spans: [{ kind: 'text', text: raw }] })
      continue
    }
    const h = raw.match(/^(#{1,4})\s+(.*)/)
    if (h) {
      blocks.push({ kind: `h${h[1].length}` as BlockKind, spans: parseInline(h[2]) })
      continue
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      blocks.push({ kind: 'li', spans: parseInline(raw.replace(/^\s*[-*]\s+/, '')) })
      continue
    }
    if (/^\s*---\s*$/.test(raw)) {
      blocks.push({ kind: 'hr', spans: [] })
      continue
    }
    if (raw.trim() === '') continue
    blocks.push({ kind: 'p', spans: parseInline(raw) })
  }
  return blocks
}
