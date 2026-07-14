// Epic AG / AG5 — agent avatar pictures.
//
// Storage decision: the image is stored as a data URI in `agents.avatar_url`.
// The backend has no blob store, no @fastify/static and no S3 SDK, and adding one
// for a handful of small square images is not worth it. A data URI also rides the
// existing Clerk-authenticated JSON responses — a separate `GET /avatar` route
// could not be used from an <img src>, because the browser would not attach the
// bearer token to that request.
//
// The trade is payload size, so the bytes are capped hard here and the uploader
// downscales in the browser first. If avatars ever need to be large or numerous,
// this is the seam to swap for a blob store: the column keeps holding a URL.

export const ALLOWED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Max stored bytes. A 256×256 webp is typically 10–30KB; this leaves headroom. */
export const MAX_AVATAR_BYTES = 256 * 1024

export type AvatarError = { ok: false; error: string }
export type AvatarOk = { ok: true; dataUri: string; bytes: number; contentType: string }

const normalizeType = (t: string | undefined | null): string => (t ?? '').split(';')[0].trim().toLowerCase()

export function isAllowedAvatarType(contentType: string | undefined | null): boolean {
  return (ALLOWED_AVATAR_TYPES as readonly string[]).includes(normalizeType(contentType))
}

/**
 * Validate an uploaded image and render it as a data URI.
 * Rejects: a non-image type, an empty file, and anything over the byte cap.
 */
export function buildAvatarDataUri(contentType: string | undefined | null, data: Buffer | Uint8Array): AvatarOk | AvatarError {
  const type = normalizeType(contentType)
  if (!isAllowedAvatarType(type)) {
    return { ok: false, error: `Unsupported image type${type ? ` "${type}"` : ''}. Use PNG, JPEG, WebP or GIF.` }
  }
  const bytes = data.byteLength
  if (bytes === 0) return { ok: false, error: 'The uploaded file is empty.' }
  if (bytes > MAX_AVATAR_BYTES) {
    return { ok: false, error: `Image is ${Math.round(bytes / 1024)}KB; the limit is ${MAX_AVATAR_BYTES / 1024}KB. Use a smaller picture.` }
  }
  const b64 = Buffer.from(data).toString('base64')
  return { ok: true, dataUri: `data:${type};base64,${b64}`, bytes, contentType: type }
}

/**
 * True when a stored value is one of ours (a data URI of an allowed image type).
 * Guards the read path: an `avatar_url` that somehow holds `javascript:` or a
 * remote tracker URL must never reach an <img src>.
 */
export function isSafeAvatarValue(value: string | null | undefined): boolean {
  if (!value) return false
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!m) return false
  return isAllowedAvatarType(m[1])
}
