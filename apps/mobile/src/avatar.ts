// MOB-7c — agent avatar pictures on the phone: the pure half.
//
// The web shows an agent's uploaded picture wherever it shows an agent (its
// `AgentAvatar`, web/app/dashboard/agent/shared.tsx:39-51). The picture is an
// `avatarUrl` on the agent row — a base64 data URI the backend builds and stores
// in `agents.avatar_url` (backend/src/services/agent-avatar.ts), so it rides the
// same JSON the phone already fetches; there is NO separate image endpoint and no
// auth header to attach (the bytes are inline). When `avatarUrl` is absent the web
// falls back to `avatarEmoji || '🤖'`. This module encodes exactly that decision.
//
// WHY THE SAFETY GATE. The web relies on the WRITE path (`buildAvatarDataUri`) to
// guarantee a stored value is a clean image data URI, and never re-checks on read
// (its `isSafeAvatarValue` is exported but unwired). The phone renders whatever
// the wire hands it straight into an <Image source={{uri}}>, so it re-implements
// the backend's own read-path guard here: a value that somehow held `javascript:`,
// a remote tracker URL, or `data:image/svg+xml` (an XSS vector in a WebView) must
// never reach <Image>. `avatar.test.ts` imports the backend guard and pins this
// mirror to it, so a change to the allow-list on the server fails the phone.
//
// No React / react-native here on purpose — avatar.test.ts (and the backend guard
// it pins against) load under `node --test --experimental-strip-types`, outside
// Metro. The <Image>/<Text> rendering lives in AgentAvatar.tsx.

/** The emoji shown when an agent has no picture. Mirrors the web's `|| '🤖'`. */
export const FALLBACK_EMOJI = '🤖'

/**
 * The image types the backend stores — a mirror of `ALLOWED_AVATAR_TYPES` in
 * backend/src/services/agent-avatar.ts, pinned equal by avatar.test.ts. Note SVG
 * is deliberately NOT here: it can carry script.
 */
export const ALLOWED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const normalizeType = (t: string | undefined | null): string =>
  (t ?? '').split(';')[0].trim().toLowerCase()

/** Mirror of the backend's `isAllowedAvatarType`. */
export function isAllowedAvatarType(contentType: string | undefined | null): boolean {
  return (ALLOWED_AVATAR_TYPES as readonly string[]).includes(normalizeType(contentType))
}

/**
 * True when a stored value is one of ours: a base64 data URI of an allowed image
 * type. A byte-for-byte mirror of the backend's `isSafeAvatarValue`
 * (backend/src/services/agent-avatar.ts) — avatar.test.ts asserts the two agree.
 */
export function isSafeAvatarValue(value: string | null | undefined): boolean {
  if (!value) return false
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!m) return false
  return isAllowedAvatarType(m[1])
}

/** The fields any avatar-bearing agent shape carries. Superset-tolerant. */
export interface AvatarInput {
  avatarUrl?: string | null
  avatarEmoji?: string | null
}

/**
 * The picture to render, or null to fall back to the emoji. Mirrors the web's
 * `agent.avatarUrl ? <img> : emoji`, plus the safety gate the web leans on the
 * write path for — the phone cannot assume the value came from our uploader.
 */
export function avatarImageUri(agent: AvatarInput): string | null {
  return agent.avatarUrl && isSafeAvatarValue(agent.avatarUrl) ? agent.avatarUrl : null
}

/**
 * The emoji to render when there's no picture — also the <Image> onError landing,
 * so a well-formed value that fails to load still shows a face, never a broken box.
 */
export function avatarEmoji(agent: AvatarInput): string {
  return agent.avatarEmoji || FALLBACK_EMOJI
}
