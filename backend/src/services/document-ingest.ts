// ─── Document ingestion ──────────────────────────────────────────────────────
// Extract text from an uploaded file (PDF / DOCX / PPTX / XLSX / TXT / MD) and
// summarise it into clean Markdown via the org's configured LLM. The summary is
// stored as a knowledge item and (optionally) written into mission/culture.

import { convert } from 'officeparser'
import { streamLLM } from './llm-router'

// Input budget for summarisation (~15k tokens). Large docs are clipped; a future
// pass could map-reduce instead. Surfaced to the caller via wasClipped.
export const MAX_SUMMARY_INPUT_CHARS = 60_000

const PLAIN_TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json'])

export function fileExtension(filename: string): string {
  return (filename.split('.').pop() ?? '').toLowerCase()
}

// Extract raw text from a file buffer. Plain-text formats are decoded directly;
// everything else goes through officeparser (pdf/docx/pptx/xlsx/odt/odp/ods).
export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const ext = fileExtension(filename)
  if (PLAIN_TEXT_EXTS.has(ext)) return buffer.toString('utf-8')
  // officeparser v7: convert any supported binary doc (pdf/docx/pptx/xlsx/odt…) to plain
  // text. From a Buffer the file type can't be sniffed, so pass it via parseConfig.fileType.
  const { value } = await convert(buffer, 'text', { parseConfig: { fileType: ext as any } })
  return (typeof value === 'string' ? value : String(value ?? '')).trim()
}

const TARGET_LABELS: Record<string, string> = {
  mission: 'Mission & Vision',
  culture: 'Culture & Principles',
  knowledge: 'reference knowledge',
}

export function summaryInstruction(target: string): string {
  const label = TARGET_LABELS[target] ?? 'reference knowledge'
  return [
    `You are a precise document summariser for an organisation's shared knowledge base.`,
    `Produce a clean, well-structured **Markdown** summary of the document provided.`,
    `It will be stored as the organisation's "${label}" and read by every AI agent, so be faithful and self-contained.`,
    `Use headings and bullet points; preserve key facts, figures, names, dates, and decisions; drop boilerplate.`,
    `Output ONLY the Markdown summary — no preamble, no code fences.`,
  ].join(' ')
}

export async function summariseToMarkdown(opts: {
  text: string
  filename: string
  target: string
  provider: string
  model: string
  orgApiKey?: string
  baseURL?: string
}): Promise<{ summary: string; wasClipped: boolean }> {
  const wasClipped = opts.text.length > MAX_SUMMARY_INPUT_CHARS
  const clipped = opts.text.slice(0, MAX_SUMMARY_INPUT_CHARS)
  const userMsg = `Document filename: ${opts.filename}\n\n=== DOCUMENT CONTENT ===\n${clipped}`

  const result = await streamLLM({
    provider: opts.provider,
    model: opts.model,
    system: summaryInstruction(opts.target),
    messages: [{ role: 'user', content: userMsg }],
    orgApiKey: opts.orgApiKey,
    baseURL: opts.baseURL,
    onToken: () => {},
  })

  let summary = result.output.trim()
  if (wasClipped) summary += `\n\n_— summary based on the first ${MAX_SUMMARY_INPUT_CHARS.toLocaleString()} characters of the document._`
  return { summary, wasClipped }
}
