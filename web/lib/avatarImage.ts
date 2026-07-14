// Epic AG / AG5 — avatar upload helpers.
//
// The backend stores an avatar as a capped data URI (256KB), so the browser
// downscales the picture BEFORE upload: the operator can drop in a 4MB photo and
// it lands as a ~20KB square. The geometry is pure (and tested); only
// `downscaleAvatar` touches the DOM.

/** Longest edge of a stored avatar. Bigger than any place we render it (56px header, 96px config, retina). */
export const AVATAR_MAX_EDGE = 256

/** Types the backend accepts. GIF is passed through untouched so it keeps animating. */
export const ACCEPTED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Fit (w, h) inside a `max`-square, preserving aspect ratio. Never upscales — a
 * 64×64 icon stays 64×64 rather than being blown up and blurred.
 */
export function scaleDims(w: number, h: number, max: number = AVATAR_MAX_EDGE): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 }
  const longest = Math.max(w, h)
  if (longest <= max) return { width: Math.round(w), height: Math.round(h) }
  const k = max / longest
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/** The output type for a re-encoded avatar (WebP where supported, else JPEG). */
export function encodeType(canBeWebp: boolean): 'image/webp' | 'image/jpeg' {
  return canBeWebp ? 'image/webp' : 'image/jpeg'
}

export function isAcceptedUpload(type: string | undefined | null): boolean {
  return ACCEPTED_UPLOAD_TYPES.includes((type ?? '').toLowerCase())
}

/**
 * Downscale + re-encode an image file in the browser. Returns the original File
 * untouched for GIFs (re-encoding would kill the animation) and whenever the
 * canvas path fails — the backend caps and validates regardless, so the worst
 * case is a rejected upload with a clear message, never a corrupted avatar.
 */
export async function downscaleAvatar(file: File, max: number = AVATAR_MAX_EDGE): Promise<Blob> {
  if (file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = scaleDims(bitmap.width, bitmap.height, max)
    if (!width || !height) return file

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    const webpOk = canvas.toDataURL('image/webp').startsWith('data:image/webp')
    const type = encodeType(webpOk)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.9))
    return blob ?? file
  } catch {
    return file
  }
}
