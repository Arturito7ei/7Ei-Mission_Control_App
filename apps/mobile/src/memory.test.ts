// MOB-6e — tripwires for the vault reader.
//
// Two different kinds of pinning here, because the web's Memory tab splits into
// two halves that are testable in very different ways:
//
//  1. THE PATH RULES are mirrored from the BACKEND (`services/vault-connector.ts`),
//     which is plain `.ts` — so these tests import it and diff, exactly as
//     attach.test.ts does against the web's assistant.logic. This is the half
//     that matters most: `isNotePath` decides what the phone offers as tappable,
//     and if it drifts from the server's `isMarkdownPath`, the phone either hides
//     notes the desk can read or offers ones the server will 400 on.
//
//  2. THE MARKDOWN SUBSET is mirrored from the WEB's `mdToHtml` — which is NOT
//     exported and NOT importable (it's a module-private function inside a
//     'use client' .tsx that imports React). So there is no module to diff
//     against; what's pinned instead is the SUBSET ITSELF — every construct the
//     web's line loop handles must survive the parse, so a note that renders on
//     the desk renders on the phone. Same trade taskLog.ts/costs.ts make.
//
// Zero-dep: node --test --experimental-strip-types.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import {
  isMarkdownPath as backendIsMarkdownPath,
  isSafeVaultPath as backendIsSafeVaultPath,
  defaultVaultConfig,
} from '../../../backend/src/services/vault-connector.ts'
import {
  MEMORY_GRAPH_NOTE,
  VAULT_DEFAULT,
  baseName,
  breadcrumb,
  entryGlyph,
  flattenTree,
  isNotePath,
  isSafeVaultPath,
  parseInline,
  parseMarkdown,
  sortEntries,
  type VaultDirs,
  type VaultEntryLite,
} from './memory.ts'

// ─── The path rules must not drift from the server's ─────────────────────────

test('[MOB-6e] isNotePath agrees with the backend’s isMarkdownPath, extension for extension', () => {
  const paths = [
    'vault/a.md', 'vault/a.markdown', 'vault/a.txt',
    'vault/A.MD', 'vault/a.Markdown', 'vault/deep/nest/note.md',
    // Not notes — the reader must not offer these.
    'vault/img.png', 'vault/a.mdx', 'vault/data.json', 'vault/README', 'vault/md',
    'vault/a.md.png', 'vault/folder.md/child.png', '', 'vault/.md',
  ]
  for (const p of paths) {
    assert.equal(isNotePath(p), backendIsMarkdownPath(p), `disagreed on "${p}"`)
  }
})

test('[MOB-6e] the phone refuses exactly the traversals the backend refuses', () => {
  const cases: [string, string][] = [
    ['vault', 'vault'],
    ['vault/notes', 'vault'],
    ['vault/../etc/passwd', 'vault'],
    ['..', 'vault'],
    ['vault/..', 'vault'],
    ['other', 'vault'],
    ['vaultish/x', 'vault'],
    ['vault\\win', 'vault'],
    ['/vault/notes', 'vault'],
    ['', 'vault'],
    ['docs/a.md', 'docs'],
  ]
  for (const [p, root] of cases) {
    assert.equal(isSafeVaultPath(p, root), backendIsSafeVaultPath(p, root), `disagreed on "${p}" @ "${root}"`)
  }
})

test('[MOB-6e] the default vault is the backend’s default vault', () => {
  // The phone prints this label before the first response lands. If it drifts,
  // the screen names a vault it isn't reading.
  assert.deepEqual(VAULT_DEFAULT, defaultVaultConfig())
})

// ─── Ordering ────────────────────────────────────────────────────────────────

test('[MOB-6e] folders sort before files, each A–Z case-insensitively', () => {
  const entries: VaultEntryLite[] = [
    { name: 'zebra.md', path: 'v/zebra.md', type: 'file' },
    { name: 'Beta', path: 'v/Beta', type: 'dir' },
    { name: 'alpha.md', path: 'v/alpha.md', type: 'file' },
    { name: 'archive', path: 'v/archive', type: 'dir' },
  ]
  // Dirs first (archive before Beta — case-insensitive, so a lowercase name is
  // not exiled below the uppercase ones), then files A–Z.
  assert.deepEqual(sortEntries(entries).map((e) => e.name), ['archive', 'Beta', 'alpha.md', 'zebra.md'])
})

test('[MOB-6e] sortEntries does not mutate its input', () => {
  const entries: VaultEntryLite[] = [
    { name: 'b.md', path: 'v/b.md', type: 'file' },
    { name: 'a', path: 'v/a', type: 'dir' },
  ]
  const before = entries.map((e) => e.name)
  sortEntries(entries)
  assert.deepEqual(entries.map((e) => e.name), before)
})

// ─── The flattened tree ──────────────────────────────────────────────────────

const DIRS: VaultDirs = {
  vault: [
    { name: 'Protocols', path: 'vault/Protocols', type: 'dir' },
    { name: 'README.md', path: 'vault/README.md', type: 'file' },
  ],
  'vault/Protocols': [
    { name: '7Ei_OS', path: 'vault/Protocols/7Ei_OS', type: 'dir' },
    { name: 'intro.md', path: 'vault/Protocols/intro.md', type: 'file' },
  ],
  'vault/Protocols/7Ei_OS': [{ name: 'memory.md', path: 'vault/Protocols/7Ei_OS/memory.md', type: 'file' }],
}

test('[MOB-6e] a collapsed tree shows only the root’s own children', () => {
  const rows = flattenTree(DIRS, 'vault', new Set())
  assert.deepEqual(rows.map((r) => r.entry.name), ['Protocols', 'README.md'])
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[0].expanded, false)
})

test('[MOB-6e] expanding splices children in beneath their folder, at depth+1', () => {
  const rows = flattenTree(DIRS, 'vault', new Set(['vault/Protocols']))
  assert.deepEqual(rows.map((r) => r.entry.name), ['Protocols', '7Ei_OS', 'intro.md', 'README.md'])
  // The rest of the vault keeps its place: README.md is still last, still depth 0.
  const readme = rows[rows.length - 1]
  assert.equal(readme.entry.name, 'README.md')
  assert.equal(readme.depth, 0)
  assert.equal(rows[1].depth, 1)
})

test('[MOB-6e] nesting indents cumulatively', () => {
  const rows = flattenTree(DIRS, 'vault', new Set(['vault/Protocols', 'vault/Protocols/7Ei_OS']))
  const deep = rows.find((r) => r.entry.name === 'memory.md')!
  assert.equal(deep.depth, 2)
  assert.deepEqual(rows.map((r) => r.entry.name), ['Protocols', '7Ei_OS', 'memory.md', 'intro.md', 'README.md'])
})

test('[MOB-6e] only EXPANDED folders cost a walk — a closed subtree is never visited', () => {
  // The perf contract: rows are O(visible), not O(vault). A fetched-but-closed
  // folder contributes exactly one row.
  const rows = flattenTree(DIRS, 'vault', new Set())
  assert.equal(rows.length, 2)
  assert.ok(!rows.some((r) => r.entry.name === 'intro.md'))
})

test('[MOB-6e] an expanded folder with no children yet reads as loading, not as empty', () => {
  // The distinction the operator actually cares about: "still fetching" vs
  // "this folder is empty". Showing 'empty' during a fetch is a lie that resolves.
  const open = new Set(['vault/Protocols'])
  const fetching = flattenTree({ vault: DIRS.vault }, 'vault', open, new Set(['vault/Protocols']))
  assert.equal(fetching[0].loading, true)
  // Landed and genuinely empty → not loading, and it contributes no child rows
  // (the root's other entry is still there, untouched).
  const empty = flattenTree({ vault: DIRS.vault, 'vault/Protocols': [] }, 'vault', open, new Set())
  assert.equal(empty[0].loading, false)
  assert.deepEqual(empty.map((r) => r.entry.name), ['Protocols', 'README.md'])
})

test('[MOB-6e] an unfetched root renders nothing rather than throwing', () => {
  assert.deepEqual(flattenTree({}, 'vault', new Set()), [])
})

test('[MOB-6e] a malformed response cannot hang the walk', () => {
  // A vault is a git tree and cannot contain a cycle — but this walks a remote
  // API's output, and a hang on a phone is a hang with no console to explain it.
  const looped: VaultDirs = { vault: [{ name: 'self', path: 'vault', type: 'dir' }] }
  const rows = flattenTree(looped, 'vault', new Set(['vault']))
  assert.ok(rows.length >= 1)
})

test('[MOB-6e] every row is distinguishable without colour', () => {
  const rows = flattenTree(DIRS, 'vault', new Set(['vault/Protocols']))
  assert.equal(entryGlyph(rows[0]), '▾', 'an open folder')
  assert.equal(entryGlyph(flattenTree(DIRS, 'vault', new Set())[0]), '▸', 'a closed folder')
  assert.equal(entryGlyph(rows[rows.length - 1]), '📄', 'a readable note')
  // A non-note is visibly a different thing — it isn't tappable.
  const png: VaultEntryLite = { name: 'x.png', path: 'v/x.png', type: 'file' }
  assert.equal(entryGlyph({ entry: png, depth: 0, expanded: false, loading: false }), '📎')
})

// ─── Labels ──────────────────────────────────────────────────────────────────

test('[MOB-6e] the breadcrumb reads as a trail, and a basename is the note', () => {
  assert.equal(breadcrumb('vault/Protocols/7Ei_OS'), 'vault / Protocols / 7Ei_OS')
  assert.equal(breadcrumb('/vault//x/'), 'vault / x', 'stray slashes must not print as empty crumbs')
  assert.equal(breadcrumb(''), '')
  assert.equal(baseName('vault/Protocols/memory.md'), 'memory.md')
  assert.equal(baseName('note.md'), 'note.md')
  assert.equal(baseName(''), '')
})

test('[MOB-6e] the dropped graph is explained on the screen, not just in a doc', () => {
  assert.match(MEMORY_GRAPH_NOTE, /desktop/i)
})

test('[MEM-1] the note points at Links — the canvas is dropped, the data is not', () => {
  // MEM-1 brought the link DATA to the phone as a list. A note still claiming
  // the vault is "all here" while link structure lives one tab over would send
  // the operator hunting in the tree for something the tree cannot show.
  assert.match(MEMORY_GRAPH_NOTE, /links/i)
  assert.doesNotMatch(MEMORY_GRAPH_NOTE, /the vault itself is all here/i)
})

// ─── Markdown — the web's subset, construct for construct ────────────────────

test('[MOB-6e] every block the web’s mdToHtml handles survives the parse', () => {
  const blocks = parseMarkdown(
    ['# H1', '## H2', '### H3', '#### H4', 'a paragraph', '- item one', '* item two', '---', ''].join('\n'),
  )
  assert.deepEqual(blocks.map((b) => b.kind), ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'li', 'hr'])
  // A blank line is dropped, exactly as the web drops it to ''.
  assert.ok(!blocks.some((b) => b.kind === 'p' && b.spans[0].text === ''))
})

test('[MOB-6e] a fifth-level heading is a paragraph, as on the web', () => {
  // The web matches `#{1,4}` only — ##### falls through to <p>. Mirrored, so a
  // note doesn't grow a heading level on the phone the desk doesn't have.
  assert.deepEqual(parseMarkdown('##### H5').map((b) => b.kind), ['p'])
})

test('[MOB-6e] a fenced block keeps its lines literal — markup inside is not parsed', () => {
  const blocks = parseMarkdown(['```', '# not a heading', '- not a list', '**not bold**', '```'].join('\n'))
  assert.deepEqual(blocks.map((b) => b.kind), ['code', 'code', 'code'])
  assert.equal(blocks[0].spans[0].text, '# not a heading')
  assert.equal(blocks[2].spans[0].text, '**not bold**')
})

test('[MOB-6e] an unclosed fence does not swallow the rest of the note silently', () => {
  // The web leaves <pre> open; we keep the lines as code blocks. Either way the
  // text must still be THERE — a truncated note is the unacceptable outcome.
  const blocks = parseMarkdown(['```', 'inside', 'still inside'].join('\n'))
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map((b) => b.spans[0].text), ['inside', 'still inside'])
})

test('[MOB-6e] the inline run mirrors the web’s replaces', () => {
  assert.deepEqual(parseInline('`code`'), [{ kind: 'code', text: 'code' }])
  assert.deepEqual(parseInline('**bold**'), [{ kind: 'strong', text: 'bold' }])
  assert.deepEqual(parseInline('*em*'), [{ kind: 'em', text: 'em' }])
  assert.deepEqual(parseInline('[[Wiki Link]]'), [{ kind: 'wikilink', text: 'Wiki Link' }])
  assert.deepEqual(parseInline('[label](https://7ei.ai)'), [
    { kind: 'link', text: 'label', href: 'https://7ei.ai' },
  ])
})

test('[MOB-6e] bold wins over italic — `**x**` is not two italics', () => {
  assert.deepEqual(parseInline('**x**'), [{ kind: 'strong', text: 'x' }])
  const mixed = parseInline('**b** and *i*')
  assert.deepEqual(mixed.map((s) => s.kind), ['strong', 'text', 'em'])
})

test('[MOB-6e] text around a span is kept, in order', () => {
  assert.deepEqual(parseInline('see `x` now'), [
    { kind: 'text', text: 'see ' },
    { kind: 'code', text: 'x' },
    { kind: 'text', text: ' now' },
  ])
})

test('[MOB-6e] a plain line is one text span, and never empty', () => {
  assert.deepEqual(parseInline('plain'), [{ kind: 'text', text: 'plain' }])
  assert.deepEqual(parseInline(''), [{ kind: 'text', text: '' }])
})

test('[MOB-6e] vault content is data, never markup — there is no HTML path at all', () => {
  // The web escapes then sets innerHTML; the phone parses to spans and renders
  // <Text>. A note is UNTRUSTED (any agent with a vault token can write one), so
  // pin that a tag arrives as literal text with no interpretation.
  const blocks = parseMarkdown('<script>alert(1)</script>')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'p')
  assert.equal(blocks[0].spans[0].text, '<script>alert(1)</script>')
  assert.equal(blocks[0].spans[0].kind, 'text')
})

test('[MOB-6e] an empty note parses to nothing rather than throwing', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n\n'), [])
})

// ─── Source-level guard: state updaters must stay pure ───────────────────────
//
// AUDIT (MOB-6e, Low): `MemoryScreen` called `loadDir(path)` from INSIDE the
// `setExpanded` updater. React deliberately double-invokes updaters under
// StrictMode to surface exactly this, so opening a folder would have fired TWO
// GETs — and on a slow link, two responses racing into `dirs`. The side effect
// belongs to the EVENT, not to the state transition.
//
// No unit test can reach it: the screens import react-native and cannot load
// under `node --test` (the constraint navModel.test.ts and status.test.ts both
// work around). So the call site gets a source-level guard, in the shape
// status.test.ts already established — this is the assertion that fails if
// someone writes the defect back.
const EFFECTS = [
  { re: /\bloadDir\s*\(/, why: 'fetches a directory' },
  { re: /\bApi\.\w+\s*\(/, why: 'calls the API client' },
  { re: /\bfetch\s*\(/, why: 'fetches' },
  { re: /\bawait\b/, why: 'awaits' },
]

/** The body of every `setX((…) => …)` updater in a source file. */
function updaterBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = []
  const re = /\b(set[A-Z]\w*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1 // the call's own '('
    // Functional updaters only: `setX(value)` passing a plain value has no body
    // to be impure in. The walk must start at the CALL's paren, not the arrow's
    // parameter list — starting at the latter would stop dead on `(x)`.
    if (!/^\s*(\(|function\b|async\b)/.test(src.slice(open + 1))) continue
    // Walk to the matching close, so a nested `(`/`{` can't end the scan early.
    let depth = 0
    let i = open
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '(' || c === '{') depth++
      else if (c === ')' || c === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ name: m[1], body: src.slice(m.index, i + 1) })
  }
  return out
}

test('[MOB-6e] no screen performs a side effect inside a state updater', async () => {
  const dir = new URL('./screens/', import.meta.url)
  let checked = 0
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.tsx')) continue
    const src = await readFile(new URL(file, dir), 'utf8')
    for (const { name, body } of updaterBodies(src)) {
      checked++
      for (const { re, why } of EFFECTS) {
        assert.ok(
          !re.test(body),
          `${file}: the ${name}(…) updater ${why}. React double-invokes updaters ` +
            'under StrictMode, so this fires the effect twice per event. Compute ' +
            'the next state in the updater and do the effect in the handler body.',
        )
      }
    }
  }
  // A guard that silently matches nothing passes forever. Prove it has teeth.
  assert.ok(checked > 0, 'the updater scan found no updaters — the pattern has drifted')
})

test('[MOB-6e] the updater scan actually detects the defect it guards against', () => {
  // The guard above is a regex over source. If its scan were wrong it would pass
  // on the very code it exists to reject, so feed it the ORIGINAL defect verbatim.
  const defect = `
    setExpanded((x) => {
      const n = new Set(x)
      if (n.has(path)) n.delete(path)
      else {
        n.add(path)
        if (dirs[path] === undefined) loadDir(path)
      }
      return n
    })
  `
  const bodies = updaterBodies(defect)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].name, 'setExpanded')
  assert.ok(/\bloadDir\s*\(/.test(bodies[0].body), 'the scan must see the whole updater body')

  // And the shipped shape — pure updater, effect outside — must pass.
  const fixed = `
    const willExpand = !expanded.has(path)
    setExpanded((x) => {
      const n = new Set(x)
      if (willExpand) n.add(path)
      else n.delete(path)
      return n
    })
    if (willExpand && dirs[path] === undefined) loadDir(path)
  `
  const fixedBodies = updaterBodies(fixed)
  assert.equal(fixedBodies.length, 1)
  assert.ok(!/\bloadDir\s*\(/.test(fixedBodies[0].body), 'the effect must fall outside the updater')
})
