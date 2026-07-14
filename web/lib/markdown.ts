// Epic AG / AG3 — a deliberately small markdown block parser for the agent
// Instructions viewer. Pure, zero-dependency (the repo rule is: don't add a
// package when a built-in or a few lines will do), and it returns DATA, never
// HTML — the renderer turns these blocks into React elements, so no
// `dangerouslySetInnerHTML` and therefore no XSS surface for file content.
//
// Scope on purpose: headings, bullet/numbered lists, fenced code, blockquotes,
// horizontal rules, paragraphs, and inline `code`. Not a CommonMark engine.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Inline[] }
  | { kind: 'paragraph'; spans: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'quote'; spans: Inline[] }
  | { kind: 'rule' }

/** Split a line into inline spans: `code`, **strong**, and plain text. */
export function parseInline(line: string): Inline[] {
  const spans: Inline[] = []
  // One pass, alternating between the two delimiters we support.
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) spans.push({ kind: 'text', text: line.slice(last, at) })
    const tok = m[0]
    if (tok.startsWith('`')) spans.push({ kind: 'code', text: tok.slice(1, -1) })
    else spans.push({ kind: 'strong', text: tok.slice(2, -2) })
    last = at + tok.length
  }
  if (last < line.length) spans.push({ kind: 'text', text: line.slice(last) })
  return spans.length ? spans : [{ kind: 'text', text: '' }]
}

export function parseMarkdown(src: string): Block[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code — everything inside is verbatim, including markdown syntax.
    const fence = /^```(\w+)?\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? null
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++ }
      i++ // consume the closing fence (tolerates an unterminated one at EOF)
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      continue
    }

    if (!line.trim()) { i++; continue }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ kind: 'rule' }); i++; continue }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3, spans: parseInline(h[2].trim()) })
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push({ kind: 'quote', spans: parseInline(body.join(' ')) })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/
    const number = /^\s*\d+[.)]\s+(.*)$/
    if (bullet.test(line) || number.test(line)) {
      const ordered = !bullet.test(line)
      const items: Inline[][] = []
      const re = ordered ? number : bullet
      while (i < lines.length && re.test(lines[i])) {
        items.push(parseInline(re.exec(lines[i])![1]))
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // Paragraph — consecutive non-blank lines that start no other block.
    const para: string[] = []
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,3})\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^>\s?/.test(lines[i])
      && !bullet.test(lines[i]) && !number.test(lines[i]) && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(para.join(' ')) })
  }

  return blocks
}
