// ─── Converse attachments ────────────────────────────────────────────────────
// The operator can attach a document to a Command Center turn. This module holds
// the PURE decisions — type/size gating, truncation, and how the extracted text
// is delimited into the prompt — so they're unit-tested without a server, and so
// the route stays a thin shell (the repo's pure-logic convention).
//
// Text extraction itself is NOT re-implemented here: it reuses `extractText`
// from ./document-ingest (officeparser), the same parser the knowledge
// ingest-file route uses. This module only decides *whether* to parse and *how*
// the result reaches the model.

import { fileExtension, isSupportedDocExt, SUPPORTED_DOC_EXTS } from './document-ingest'

/** Hard byte ceiling for one attached document (below the 25 MB multipart cap). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * Character budget for the extracted text injected into ONE conversational turn
 * (~10k tokens). Deliberately below document-ingest's 60k summarisation budget:
 * a converse turn also carries the system prompt, live-awareness block, and up
 * to 10 history turns, and it must survive on a small local Ollama model too.
 * Over-budget documents are clipped and the operator is TOLD (never silently).
 */
export const MAX_ATTACHMENT_CONTEXT_CHARS = 40_000

export const SUPPORTED_ATTACHMENT_EXTS = SUPPORTED_DOC_EXTS

export interface AttachmentRejection { code: 'unsupported_type' | 'too_large' | 'empty'; error: string }

/**
 * Gate a candidate file BEFORE parsing. Returns null when acceptable, otherwise
 * the operator-facing reason. Messages name the fix (which types, what limit) —
 * a bare "invalid file" would send the operator to devtools.
 */
export function checkAttachment(input: { filename: string; size: number }): AttachmentRejection | null {
  if (!input.filename.trim()) return { code: 'unsupported_type', error: 'The attached file has no name.' }
  if (!isSupportedDocExt(input.filename)) {
    const ext = fileExtension(input.filename)
    return {
      code: 'unsupported_type',
      error: `I can't read .${ext} files. Supported types: ${SUPPORTED_ATTACHMENT_EXTS.join(', ')}.`,
    }
  }
  if (input.size <= 0) return { code: 'empty', error: 'That file is empty.' }
  if (input.size > MAX_ATTACHMENT_BYTES) {
    return {
      code: 'too_large',
      error: `That file is ${formatBytes(input.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
    }
  }
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Clip extracted text to the per-turn budget, reporting whether it was cut. */
export function clipAttachmentText(text: string, budget = MAX_ATTACHMENT_CONTEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false }
  return { text: text.slice(0, budget), truncated: true }
}

export interface Attachment { name: string; text: string; truncated?: boolean }

/**
 * The delimited context block. Explicit fences + a standing instruction because
 * an LLM handed bare text after a question tends to either ignore it or mistake
 * it for the operator's own words. The block also states the truncation up front,
 * so the model can say "the rest was cut" rather than invent the missing tail.
 */
export function buildAttachmentBlock(att: Attachment): string {
  const head = `=== ATTACHED DOCUMENT: ${att.name} ===`
  const note = att.truncated
    ? `(TRUNCATED — only the first ${MAX_ATTACHMENT_CONTEXT_CHARS.toLocaleString()} characters of this document are shown. Say so if the answer needs the rest.)`
    : null
  return [
    'The operator attached a document to this message. Use it as the primary source when answering, and quote/cite it where useful.',
    head,
    note,
    att.text.trim(),
    `=== END ATTACHED DOCUMENT: ${att.name} ===`,
  ].filter(Boolean).join('\n')
}

/**
 * The final user turn: the operator's message followed by the document block.
 * Message first — the question frames what to do with the document, and burying
 * it under 40k characters of text reads as an afterthought to the model.
 */
export function withAttachmentContext(message: string, att: Attachment | null | undefined): string {
  if (!att || !att.text.trim()) return message
  return `${message}\n\n${buildAttachmentBlock(att)}`
}
