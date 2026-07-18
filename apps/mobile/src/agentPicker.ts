// GC-1 — the Command Center "To:" picker, phone side. DECISIONS ONLY.
//
// Dep-free on purpose: Metro cannot import from `web/`, so the phone hand-copies the
// desk's decisions and then pins the copy with a test that imports the web module and
// asserts they agree (`agentPicker.test.ts`). A copy without a tripwire is silent drift,
// which is the standing rule in the root CLAUDE.md.
//
// This file imports NOTHING — not react-native, not ./api — so `node --test` can load it
// directly. (See AgentAvatar.tsx: a module that imports react-native is untestable under
// this harness, and a source file here must not import a sibling with a `.ts` extension.)

/**
 * The picker's value for "Arturita" — the default recipient.
 *
 * A SENTINEL rather than her real agent id, for the same reason as on the desk: the UI
 * must render a correct default before the roster loads, and it must never send a
 * guessed id. It is translated to `null` on the way out and never reaches the wire.
 */
export const ARTURITA_CHOICE = '__arturita__'

/** Display identity for the recipient bar and for a transcript bubble. */
export type PickedAgent = {
  id: string
  name: string
  avatarEmoji?: string | null
  avatarUrl?: string | null
  role?: string | null
}

/** Arturita's display identity. Hard-coded because she is the fixed per-org front door
 *  and the phone must be able to name her before any network call has returned. */
export const ARTURITA_IDENTITY: PickedAgent = {
  id: ARTURITA_CHOICE,
  name: 'Arturita',
  avatarEmoji: '🌸',
  role: 'Chief of Staff',
}

/**
 * Map the picker's selection to the wire value.
 *
 * The sentinel and "nothing picked" both become `null`, which is what makes the default
 * request body byte-identical to the pre-GC-1 one. Must agree with the web's
 * `toWireAgentId` — pinned by the parity test.
 */
export function toWireAgentId(choice: string | null | undefined): string | null {
  if (!choice || choice === ARTURITA_CHOICE) return null
  return choice
}

/**
 * Which agents belong in the picker.
 *
 * Arturita is excluded because she IS the default entry, and terminated agents are
 * excluded because choosing one would produce a governance refusal rather than a reply.
 * Mirrors the desk's roster filter.
 */
export function pickableAgents<T extends { agentType?: string | null; status?: string | null }>(
  agents: ReadonlyArray<T> | null | undefined,
): T[] {
  return (agents ?? []).filter(a => a.agentType !== 'arturita' && a.status !== 'terminated')
}

/**
 * Resolve the selection to something renderable.
 *
 * Falls back to Arturita for an id that is not in the roster (deleted, or not yet
 * loaded), so the bar never shows a blank or a raw uuid — the operator must always be
 * able to read who is listening.
 */
export function resolveRecipient(
  choice: string | null | undefined,
  roster: ReadonlyArray<PickedAgent> | null | undefined,
): PickedAgent {
  if (!choice || choice === ARTURITA_CHOICE) return ARTURITA_IDENTITY
  const found = (roster ?? []).find(a => a.id === choice)
  return found ?? ARTURITA_IDENTITY
}

/**
 * Should this transcript turn be marked as agent-authored on the way back up?
 *
 * The marker is what makes the SERVER fence the turn as untrusted. Keyed on role so a
 * crafted user turn can never smuggle itself in as "an agent said this", and only set
 * for a real agent — Arturita's replies must keep re-entering exactly as they did.
 */
export function historyMarker(turn: {
  role: 'user' | 'assistant'
  mode?: string | null
  agentName?: string | null
}): string | null {
  if (turn.role !== 'assistant') return null
  if (turn.mode !== 'agent') return null
  return turn.agentName || null
}
