// Arturita B1 / S1 — voice CONFIG resolution (pure).
//
// S1 (confirmed 2026-07-08): voice runs under a `local | provider` config
// setting, SELECTABLE PER CONTEXT. `local` keeps sensitive audio (wallet/secret
// -adjacent) off third-party servers; `provider` uses a cloud voice — the
// interim provider is Chatterbox TTS via the NVIDIA API. Sensitive contexts are
// ALWAYS forced to `local` regardless of the configured default (privacy wins).
//
// Pure: resolves the effective mode + picks the concrete provider given what's
// available (a provider key present? a local engine installed?). The actual
// STT/TTS I/O lives in `voice-provider.ts`; the key never enters this module.

export type VoiceMode = 'local' | 'provider'

/** The org-level default, or 'auto' (fall through to a code default of local). */
export type VoiceModeSetting = VoiceMode | 'auto'

export const DEFAULT_VOICE_MODE: VoiceMode = 'local'

/** deployConfig key holding the org's default voice mode. */
export const VOICE_MODE_CONFIG_KEY = 'arturita_voice_mode'

/** Read the org's configured voice mode from deployConfig. Unknown/unset → 'auto'. */
export function parseVoiceModeSetting(deployConfig: Record<string, unknown> | null | undefined): VoiceModeSetting {
  const raw = String((deployConfig ?? {})[VOICE_MODE_CONFIG_KEY] ?? '').trim().toLowerCase()
  if (raw === 'local' || raw === 'provider') return raw
  return 'auto'
}

/** Resolve the effective mode for THIS capture. A sensitive context (wallet /
 *  secret-adjacent) is ALWAYS forced local (S1 privacy). Otherwise use the
 *  configured setting, or the code default when 'auto'. Pure. */
export function resolveVoiceMode(input: {
  setting?: VoiceModeSetting
  sensitive: boolean
  /** an explicit per-request override (e.g. the operator pins provider). */
  requested?: VoiceMode | null
}): { mode: VoiceMode; forcedLocal: boolean; reason: string } {
  if (input.sensitive) {
    return { mode: 'local', forcedLocal: true, reason: 'sensitive context — forced local (S1 privacy)' }
  }
  if (input.requested === 'local' || input.requested === 'provider') {
    return { mode: input.requested, forcedLocal: false, reason: `per-request override: ${input.requested}` }
  }
  const setting = input.setting ?? 'auto'
  if (setting === 'local' || setting === 'provider') {
    return { mode: setting, forcedLocal: false, reason: `org default: ${setting}` }
  }
  return { mode: DEFAULT_VOICE_MODE, forcedLocal: false, reason: `code default: ${DEFAULT_VOICE_MODE}` }
}

// ─── Provider selection ──────────────────────────────────────────────────────

export type VoiceProviderId = 'chatterbox_nvidia' | 'local' | 'text_only'

export interface VoiceCapabilities {
  /** a provider (cloud) key is configured, e.g. NVIDIA_API_KEY present. */
  providerKeyPresent: boolean
  /** a local STT/TTS engine is installed/available on the host. */
  localAvailable: boolean
}

/** Pick the concrete voice provider for a resolved mode + available capabilities.
 *  Fails SAFE to text-only when nothing usable is available (never drops the
 *  command — the caller renders/returns text instead of audio). Pure.
 *  - mode 'provider': cloud if a key is present, else local, else text-only.
 *  - mode 'local': local if available, else text-only (NEVER cloud — a local
 *    request must not leak to a third party). */
export function selectVoiceProvider(input: { mode: VoiceMode; caps: VoiceCapabilities }): {
  provider: VoiceProviderId
  degraded: boolean
  reason: string
} {
  const { mode, caps } = input
  if (mode === 'provider') {
    if (caps.providerKeyPresent) return { provider: 'chatterbox_nvidia', degraded: false, reason: 'provider mode — Chatterbox/NVIDIA' }
    if (caps.localAvailable) return { provider: 'local', degraded: true, reason: 'provider mode but no key — fell back to local' }
    return { provider: 'text_only', degraded: true, reason: 'provider mode but no key + no local — text-only' }
  }
  // mode === 'local' — never cloud.
  if (caps.localAvailable) return { provider: 'local', degraded: false, reason: 'local mode — on-device engine' }
  return { provider: 'text_only', degraded: true, reason: 'local mode but no local engine — text-only (no cloud leak)' }
}
