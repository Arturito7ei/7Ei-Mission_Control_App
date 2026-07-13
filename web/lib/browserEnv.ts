// Arturita STT — tiny impure browser-environment probes (no React).
//
// Kept out of the pure diagnostics module (talkDiagnostics.ts) because these
// touch `navigator`. Split so the classification logic stays unit-testable and
// the DOM sniffing lives in one place both voice panels share.

/**
 * Best-effort Brave detection. Brave exposes `navigator.brave.isBrave()` (async,
 * returns true) and no other engine does — so a true result is reliable. Any
 * error or absence resolves false. We use this only to *name Brave* in the
 * "voice input unavailable" message; the graceful degradation itself never
 * depends on it. Impure (reads `navigator`).
 */
export async function detectBrave(): Promise<boolean> {
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : null) as any
    if (!nav?.brave?.isBrave) return false
    return await nav.brave.isBrave()
  } catch {
    return false
  }
}

/** Web Speech `SpeechRecognition` (mic capture) constructor is present. Impure. */
export function hasWebSpeechStt(): boolean {
  if (typeof window === 'undefined') return false
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
}
