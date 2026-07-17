// CC-ATT (mobile) — PURE attachment logic for the Command Center composer.
//
// The MIRROR of the web's attach decisions (`web/app/dashboard/assistant.logic.ts`
// § Attachments). The operator attaches a document to a turn; it goes to
// POST /arturita/attachments/extract, and the extracted TEXT rides the next
// /converse call as `attachment`. Same two-step contract as the web — see api.ts.
//
// ⚠️ HAND-COPIED, BUT NOT ON TRUST. Metro can't reach outside apps/mobile (the
// phone installs standalone), so these constants are copied like the nav model is
// ported. What keeps them honest is `attach.test.ts`: it imports the WEB module
// directly and asserts the two agree. If you change a limit or a type here, the
// test fails until the web says the same thing — and the web itself mirrors the
// backend, which is the only real enforcer:
//   backend/src/services/converse-attachments.ts → MAX_ATTACHMENT_BYTES
//   backend/src/services/document-ingest.ts      → SUPPORTED_DOC_EXTS
//
// As on the web, these checks are a COURTESY, not a control: they fail in the
// composer — instantly, before a 10 MB upload over cellular — rather than after a
// round-trip. The server re-checks type, size, and length regardless.

/** Extensions the backend's parser can read. Mirrors the web's ATTACH_EXTS. */
export const ATTACH_EXTS = [
  'csv', 'docx', 'json', 'log', 'markdown', 'md', 'odp', 'ods', 'odt', 'pdf', 'pptx', 'tsv', 'txt', 'xlsx',
] as const

/** Mirrors the web's ATTACH_MAX_BYTES (backend MAX_ATTACHMENT_BYTES). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024

/**
 * The document attached to the NEXT turn. `text` is absent until the extract
 * call returns — the chip shows immediately on pick so the operator sees the
 * file register, and `canSendTurn` holds Send until the text is actually in hand.
 */
export interface AttachedDoc {
  name: string
  /** bytes; undefined when the OS picker doesn't report a size (see below). */
  size?: number
  /** extracted text — absent until the extract call returns. */
  text?: string
  truncated?: boolean
}

export function attachExtension(filename: string): string {
  return (filename.split('.').pop() ?? '').toLowerCase()
}

/** Byte-size wording identical to the web's formatFileSize. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Why this file can't be attached, or null if it can. Phrased for the operator:
 * it names the limit or the readable types, so the next attempt succeeds.
 *
 * `size` is optional here where the web's is required, and that is the one real
 * platform difference: iOS's picker does not always report a size. An unknown
 * size SKIPS the size check rather than guessing — the file goes up and the
 * server (the actual enforcer) answers with the same 413 wording. The type gate
 * is unconditional either way, so nothing unreadable is ever uploaded.
 */
export function rejectAttachment(file: { name: string; size?: number }): string | null {
  const ext = attachExtension(file.name)
  if (!(ATTACH_EXTS as readonly string[]).includes(ext)) {
    return `I can't read .${ext} files. Try one of: ${ATTACH_EXTS.join(', ')}.`
  }
  if (file.size == null) return null
  if (file.size <= 0) return `“${file.name}” is empty.`
  if (file.size > ATTACH_MAX_BYTES) {
    return `“${file.name}” is ${formatFileSize(file.size)} — the limit is ${formatFileSize(ATTACH_MAX_BYTES)}.`
  }
  return null
}

/** The chip label under the composer: name + size, plus a truncation hint. */
export function attachmentChipLabel(doc: AttachedDoc): string {
  const base = doc.size == null ? doc.name : `${doc.name} · ${formatFileSize(doc.size)}`
  return doc.truncated ? `${base} · truncated` : base
}

// ─── Photos (MOB-7b) ─────────────────────────────────────────────────────────
// The MIRROR of the web's photo decisions (assistant.logic.ts § Photos), pinned
// by attach.test.ts exactly as the document constants above are.
//
// A photo is NOT a document and shares none of the pipeline above: there is no
// text to extract, so there is no /attachments/extract round-trip. The picker
// hands back base64, it rides the /converse call itself, and the model's VISION
// reads it. Backend enforcer:
//   backend/src/services/converse-images.ts → MAX_IMAGE_BYTES · SUPPORTED_IMAGE_EXTS

/** Formats every vision provider reads. Mirrors the web's IMAGE_EXTS. */
export const IMAGE_EXTS = ['gif', 'jpeg', 'jpg', 'png', 'webp'] as const

/**
 * Mirrors the web's IMAGE_MAX_BYTES (backend MAX_IMAGE_BYTES). Not round on
 * purpose: base64 inflates by 4/3 and the provider caps an encoded image at
 * 5 MB, so the raw ceiling is 3/4 of that. Kept as the expression, not the
 * literal, so the reason survives.
 *
 * The phone rarely approaches it — the picker re-encodes to JPEG at quality 0.7,
 * which puts a 12 MP iPhone photo in the few-hundred-KB range. This is the
 * backstop, not the norm.
 */
export const IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024)

/**
 * The photo attached to the NEXT turn. `data` is absent until the picker returns
 * — the chip shows immediately so the operator sees the photo register, and
 * `canSendTurn` holds Send until the bytes are actually in hand.
 */
export interface AttachedImage {
  name: string
  /** bytes; undefined when the picker doesn't report a size. */
  size?: number
  /** media type, e.g. `image/jpeg`. */
  mediaType: string
  /** RAW base64 — no `data:` prefix. Absent until the picker returns. */
  data?: string
}

/**
 * Why this photo can't be attached, or null if it can. `size` is optional for the
 * same platform reason as rejectAttachment: the picker doesn't always report one,
 * and an unknown size skips the check rather than guessing — the server is the
 * real enforcer and answers with the same wording.
 */
export function rejectImage(file: { name: string; size?: number }): string | null {
  const ext = attachExtension(file.name)
  if (!(IMAGE_EXTS as readonly string[]).includes(ext)) {
    // HEIC earns its own sentence — it is what an iPhone photo natively IS, so
    // this is the rejection an operator is most likely to meet.
    const heic = ext === 'heic' || ext === 'heif'
      ? ` iPhone photos are HEIC by default — re-save it as JPEG first.`
      : ''
    return `I can't see .${ext} images. Try one of: ${IMAGE_EXTS.join(', ')}.${heic}`
  }
  if (file.size == null) return null
  if (file.size <= 0) return `“${file.name}” is empty.`
  if (file.size > IMAGE_MAX_BYTES) {
    return `“${file.name}” is ${formatFileSize(file.size)} — the limit is ${formatFileSize(IMAGE_MAX_BYTES)}. A smaller or more compressed copy will work.`
  }
  return null
}

/** The photo chip's label: name + size. */
export function imageChipLabel(img: AttachedImage): string {
  return img.size == null ? img.name : `${img.name} · ${formatFileSize(img.size)}`
}

/**
 * A send is allowed when there is text, a fully-extracted document, or a
 * fully-read photo. Mirrors the web's canSendTurn — pinned by attach.test.ts,
 * so the two clients agree on what counts as a sendable turn.
 */
export function canSendTurn(input: {
  typed: string
  attachment?: AttachedDoc | null
  image?: AttachedImage | null
  busy?: boolean
}): boolean {
  if (input.busy) return false
  if (input.typed.trim().length > 0) return true
  if (input.attachment?.text) return true
  return !!input.image?.data
}

/**
 * The `image` field for POST /arturita/converse — the same shape the web's
 * `toConverseRequest` builds. Only a photo that actually carries bytes is worth
 * sending; an empty one would cost a round-trip to be refused.
 */
export function toConverseImage(
  img: AttachedImage | null | undefined,
): { name: string; mediaType: string; data: string } | undefined {
  return img?.data?.trim() ? { name: img.name, mediaType: img.mediaType, data: img.data } : undefined
}

/**
 * The `attachment` field for POST /arturita/converse — the same shape the web's
 * `toConverseRequest` builds. Only a document that actually extracted to text is
 * worth sending; an empty one would just cost tokens for an empty block.
 */
export function toConverseAttachment(
  doc: AttachedDoc | null | undefined,
): { name: string; text: string; truncated: boolean } | undefined {
  return doc?.text?.trim() ? { name: doc.name, text: doc.text, truncated: !!doc.truncated } : undefined
}
