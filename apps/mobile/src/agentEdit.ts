// MOB-7d — the pure half of EDITING an agent's settings from the phone.
//
// This is the WRITE mirror of the web's agent-detail tabs. The web edits an agent
// over four OWNER-GATED, field-allowlisted, server-validated routes — and NOT the
// legacy unvalidated `PATCH /api/agents/:id`. The phone reuses those exact routes
// (see api.ts), so this module holds only the client-side decisions the web makes
// before it calls them: which fields exist, what the caps are, how to validate a
// form the same way the backend will, and how to build the request body.
//
// WHY THIS FILE IS IMPORT-FREE (no `./governance`, no react, no react-native):
// `agentEdit.test.ts` loads it under `node --test`, which cannot resolve an
// extensionless sibling import, while `tsc` rejects a `.ts`-extension one. So the
// constants the web copies from a JSX/`.tsx` module (which can't be import-pinned)
// AND the ones that DO have a dep-free source are all re-declared here, and the
// test pins every one of them against its real source (backend agent-config.ts,
// web/lib/agentSkills.ts, web/lib/trust.ts). A copy without that tripwire is silent
// drift; a copy WITH it is just a second, testable spelling of one decision.
//
// OWNER-ONLY, EVERY FIELD. Every editing route the phone calls here is
// `requireOrgRole('owner')` on the backend (config, model-profile, trust, skills).
// So "can I edit this agent at all" is one question — am I the org owner — not a
// per-field one. The phone gates the whole Edit affordance on the owner role it
// learns from `/api/orgs` (`memberRole`), AND relies on the backend 403 as the
// real enforcer: if the role is unknown (a pasted token whose org membership the
// phone never listed), the edit is still offered and a non-owner simply gets the
// backend's 403 surfaced cleanly — never a silent success, never a client-only gate.

// ─── Roles ─────────────────────────────────────────────────────────────────────

/** The org membership roles, mirroring the backend `OrgRole` union (rbac.ts). */
export const ORG_ROLES = ['owner', 'member'] as const
export type OrgRoleLite = (typeof ORG_ROLES)[number]

/** Owner is the only role that may edit an agent's settings (every route is
 *  `requireOrgRole('owner')`). Unknown/absent role → NOT owner (fail closed). */
export function isOwnerRole(role: string | null | undefined): boolean {
  return role === 'owner'
}

export const NON_OWNER_EDIT_NOTE =
  'Editing an agent’s settings is owner-only. You’re signed in as a member, so this screen is read-only — the same as on the desk.'

export const UNKNOWN_ROLE_EDIT_NOTE =
  'Your role in this org isn’t known on this device (you’re signed in with a pasted token). Editing is offered, but the backend still enforces owner-only — a non-owner save is refused there.'

// ─── Configuration (PUT …/agents/:id/config) ────────────────────────────────────
// MIRROR of backend/src/services/agent-config.ts — CONFIG_FIELDS, RUNTIMES, and the
// per-field caps/messages in validateConfigPatch. Pinned by agentEdit.test.ts,
// which imports that (dep-free) module and asserts agreement.

/** The fields the config route may write. Mirrors backend `CONFIG_FIELDS`. */
export const CONFIG_FIELDS = [
  'name', 'title', 'role', 'jobDescription', 'avatarEmoji',
  'reportsTo', 'runtime', 'llmProvider', 'llmModel', 'primaryModel',
  'contactChannel',
] as const

/** Runtimes the adapter picker offers. Mirrors backend `RUNTIMES`. */
export const RUNTIMES = ['internal', 'openclaw', 'cursor', 'claude_code', 'custom'] as const
export type RuntimeLite = (typeof RUNTIMES)[number]

/**
 * Adapter labels for the picker. COPIED from the web's ConfigurationTab `ADAPTERS`
 * and SkillsTab `ADAPTER_LABEL` — both live inside `.tsx` component modules, so
 * they cannot be import-tripwired. The test at least pins the KEY SET to `RUNTIMES`
 * so a new runtime can't ship without a label.
 */
export const ADAPTER_LABEL: Record<RuntimeLite, string> = {
  internal: 'Internal — the 7Ei executor (LLM API)',
  openclaw: 'OpenClaw — local BYO runtime',
  claude_code: 'Claude Code — local coding agent',
  cursor: 'Cursor — local BYO runtime',
  custom: 'Custom runtime',
}

/** Per-field character caps. Mirrors the lengths in `validateConfigPatch`. */
export const CONFIG_CAPS = {
  name: 100,
  role: 200,
  jobDescription: 4000,
  contactChannel: 200,
  /** llmProvider / llmModel / primaryModel — free-form, length-bounded only. */
  model: 200,
} as const

/** avatarEmoji is an icon, not an essay: at most 4 unicode code points (the
 *  backend counts `[...value].length`, so a ZWJ emoji sequence still fits). */
export const AVATAR_EMOJI_MAX_CODEPOINTS = 4

/** The editable identity+adapter form the Configuration section binds to. */
export interface ConfigForm {
  name: string
  title: string
  role: string
  jobDescription: string
  avatarEmoji: string
  contactChannel: string
  reportsTo: string // '' = reports to nobody (a root)
  runtime: string
  model: string // the primary model id (written to llmModel + primaryModel)
}

/** A roster node for the reports-to cycle check. Mirrors backend `AgentNode`. */
export interface AgentNode {
  id: string
  reportsTo?: string | null
}

/**
 * Would making `agentId` report to `managerId` create a cycle? A verbatim mirror
 * of `wouldCycle` in backend/src/services/agent-config.ts (pinned by the test), so
 * the phone rejects the same re-parenting the backend would 400 — before the call.
 */
export function wouldCycle(agents: AgentNode[], agentId: string, managerId: string): boolean {
  if (agentId === managerId) return true
  const byId = new Map(agents.map((a) => [a.id, a]))
  const seen = new Set<string>()
  let cursor: string | null | undefined = managerId
  while (cursor) {
    if (cursor === agentId) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = byId.get(cursor)?.reportsTo ?? null
  }
  return false
}

export type ValidationResult = { ok: true } | { ok: false; field: keyof ConfigForm; error: string }

/**
 * Validate a Configuration form the SAME way the backend's `validateConfigPatch`
 * will, using its exact messages — so a client-caught error reads identically to a
 * server-caught one, and the operator never sees two spellings of "name too long".
 * The server is still the final validator; this only saves a round-trip and points
 * at the offending field. `agents` (the roster) enables the reports-to cycle check;
 * omit it and reports-to is only existence-checked by the server.
 */
export function validateConfigForm(
  form: ConfigForm,
  ctx?: { agentId: string; agents: AgentNode[] },
): ValidationResult {
  const name = form.name.trim()
  if (!name) return { ok: false, field: 'name', error: 'Name is required.' }
  if (name.length > CONFIG_CAPS.name) return { ok: false, field: 'name', error: 'Name must be 100 characters or fewer.' }

  const role = form.role.trim()
  if (!role) return { ok: false, field: 'role', error: 'Role is required.' }
  if (role.length > CONFIG_CAPS.role) return { ok: false, field: 'role', error: 'Role must be 200 characters or fewer.' }

  const jd = form.jobDescription.trim()
  if (jd && jd.length > CONFIG_CAPS.jobDescription) {
    return { ok: false, field: 'jobDescription', error: 'Description must be 4000 characters or fewer.' }
  }

  const contact = form.contactChannel.trim()
  if (contact && contact.length > CONFIG_CAPS.contactChannel) {
    return { ok: false, field: 'contactChannel', error: 'Contact must be 200 characters or fewer.' }
  }

  const emoji = form.avatarEmoji.trim()
  if (emoji && [...emoji].length > AVATAR_EMOJI_MAX_CODEPOINTS) {
    return { ok: false, field: 'avatarEmoji', error: 'Icon must be a single emoji.' }
  }

  const runtime = form.runtime.trim()
  if (runtime && !(RUNTIMES as readonly string[]).includes(runtime)) {
    return { ok: false, field: 'runtime', error: `Unknown adapter "${runtime}".` }
  }

  const reportsTo = form.reportsTo.trim()
  if (reportsTo && ctx) {
    if (!ctx.agents.some((a) => a.id === reportsTo)) {
      return { ok: false, field: 'reportsTo', error: 'That manager is not an agent in this organisation.' }
    }
    if (wouldCycle(ctx.agents, ctx.agentId, reportsTo)) {
      return { ok: false, field: 'reportsTo', error: 'That would create a reporting loop — an agent cannot end up reporting to itself.' }
    }
  }

  const model = form.model.trim()
  if (model && model.length > CONFIG_CAPS.model) {
    return { ok: false, field: 'model', error: 'llmModel must be 200 characters or fewer.' }
  }

  return { ok: true }
}

/**
 * Build the PUT-config body, mirroring the web ConfigurationTab's `save`: the
 * identity + adapter fields always go, and the model — when set — is written to
 * BOTH `llmModel` and `primaryModel` (the web also sends `llmProvider` resolved
 * from its model catalogue; the phone has no catalogue so it omits the provider,
 * which the backend accepts — the field is optional and free-form). Values are
 * trimmed; the backend turns empty strings into null. Unknown keys can't appear
 * because the shape is closed.
 */
export function buildConfigBody(form: ConfigForm): Record<string, string> {
  const model = form.model.trim()
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    role: form.role.trim(),
    jobDescription: form.jobDescription.trim(),
    avatarEmoji: form.avatarEmoji.trim(),
    reportsTo: form.reportsTo.trim(),
    runtime: form.runtime.trim(),
    contactChannel: form.contactChannel.trim(),
    ...(model ? { llmModel: model, primaryModel: model } : {}),
  }
}

// ─── Model profile (PUT …/agents/:id/model-profile) ─────────────────────────────
// A model swap changes spend AND capability, so this is an owner-gated route of its
// own and a CONFIRMED change on the phone.

/**
 * Reasoning-effort levels. COPIED from backend `REASONING_EFFORTS`
 * (services/model-profile.ts) — which is NOT dep-free (it imports the model
 * catalogue), so it cannot be import-tripwired. The test asserts this equals the
 * literal `['low','medium','high']` instead. Empty = provider default.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffortLite = (typeof REASONING_EFFORTS)[number]

export interface ModelProfileForm {
  primaryModel: string
  cheapModel: string
  cheapModelEnabled: boolean
  reasoningEffort: string // '' | 'low' | 'medium' | 'high'
}

export type ModelProfileValidation = { ok: true } | { ok: false; field: keyof ModelProfileForm; error: string }

/** Validate the model-profile form the way `buildModelProfilePatch` will. */
export function validateModelProfileForm(form: ModelProfileForm): ModelProfileValidation {
  const primary = form.primaryModel.trim()
  if (primary && primary.length > CONFIG_CAPS.model) {
    return { ok: false, field: 'primaryModel', error: 'primaryModel must be 200 characters or fewer.' }
  }
  const cheap = form.cheapModel.trim()
  if (cheap && cheap.length > CONFIG_CAPS.model) {
    return { ok: false, field: 'cheapModel', error: 'cheapModel must be 200 characters or fewer.' }
  }
  const effort = form.reasoningEffort.trim().toLowerCase()
  if (effort && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    return { ok: false, field: 'reasoningEffort', error: `Unknown reasoning effort "${form.reasoningEffort}".` }
  }
  return { ok: true }
}

/**
 * Build the PUT model-profile body. The backend partial-updates only present keys
 * and 400s an empty patch, so we always send the four the section owns. Empty
 * strings are sent through and the backend turns them into null (primaryModel /
 * cheapModel / reasoningEffort all treat empty → null).
 */
export function buildModelProfileBody(form: ModelProfileForm): {
  primaryModel: string
  cheapModel: string
  cheapModelEnabled: boolean
  reasoningEffort: string
} {
  return {
    primaryModel: form.primaryModel.trim(),
    cheapModel: form.cheapModel.trim(),
    cheapModelEnabled: !!form.cheapModelEnabled,
    reasoningEffort: form.reasoningEffort.trim().toLowerCase(),
  }
}

export const MODEL_PROFILE_CONFIRM =
  'Change this agent’s models? A model swap changes what the agent can do and what each run costs. It runs on the new model from its next task.'

// ─── Trust tier (PUT …/agents/:id/trust) ────────────────────────────────────────
// Safety-critical: this decides what an agent is allowed to do. Owner-gated, and a
// CONFIRMED change on the phone. Boundary editing (projects/tasks/agents multiselect)
// stays on the desk — see the parity doc; the phone edits the MODE only.

/** Trust modes. Mirrors backend `TRUST_MODES` (services/review.ts) and the phone's
 *  own `governance.ts` TRUST_MODES — the test pins all three to web/lib/trust.ts. */
export const TRUST_MODES = ['standard', 'low_trust_review'] as const
export type TrustModeLite = (typeof TRUST_MODES)[number]

/** Default (and any unknown value) → standard: a garbled value never silently
 *  lowers containment. Mirrors backend `parseTrustMode` / governance.ts. */
export function parseTrustMode(m: string | null | undefined): TrustModeLite {
  return String(m ?? '').trim().toLowerCase() === 'low_trust_review' ? 'low_trust_review' : 'standard'
}

export function buildTrustBody(mode: TrustModeLite): { trustMode: TrustModeLite } {
  return { trustMode: mode }
}

/** The confirm copy names the DIRECTION, because raising and lowering containment
 *  are opposite risks and must not read as one generic "are you sure". */
export function trustConfirm(from: TrustModeLite, to: TrustModeLite): string {
  if (to === 'low_trust_review') {
    return 'Put this agent under low-trust review? Its gated actions (file-destructive, wallet, email, machine-exec, agent/skill create, task-assign) will require approval before running.'
  }
  return 'Return this agent to standard trust? It will no longer require approval for gated actions — it runs them directly. Only do this if you mean to REMOVE that containment.'
}

// ─── Skills (GET/PUT …/agents/:id/skills) ───────────────────────────────────────
// MIRROR of web/lib/agentSkills.ts (dep-free, pinned by the test). Toggling writes
// the WHOLE selection — install and uninstall are one idempotent PUT — so the phone
// predicts the server's split locally and the checkbox flips before the round-trip.

export interface SkillView {
  id: string
  name: string
  description?: string | null
  domain?: string | null
  source?: string | null
  installed: boolean
}

export interface SkillsPayload {
  installed: SkillView[]
  other: SkillView[]
  /** names stored on the agent whose library row is gone */
  orphaned: string[]
  selectedCount: number
  adapter: string
  model: string
}

/** Everything the agent currently has: library skills + orphans. */
export function selectionOf(p: Pick<SkillsPayload, 'installed' | 'orphaned'>): string[] {
  return [...p.installed.map((s) => s.name), ...p.orphaned]
}

/** Tick → add, untick → remove. */
export function nextSelection(current: string[], name: string): string[] {
  return current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
}

/**
 * Predict the server's split for a selection so the checkbox flips before the
 * round-trip. A verbatim mirror of `optimisticSplit` in web/lib/agentSkills.ts:
 * installed keeps the selection order, `other` stays alphabetical, and a selected
 * name with no library row stays an orphan (still installed, still counts).
 */
export function optimisticSplit(p: SkillsPayload, selection: string[]): SkillsPayload {
  const library = [...p.installed, ...p.other]
  const byName = new Map(library.map((s) => [s.name, s]))
  const wanted = [...new Set(selection.map((n) => n.trim()).filter(Boolean))]

  const installed: SkillView[] = []
  const orphaned: string[] = []
  for (const name of wanted) {
    const s = byName.get(name)
    if (s) installed.push({ ...s, installed: true })
    else orphaned.push(name)
  }

  const on = new Set(installed.map((s) => s.name))
  const other = library
    .filter((s) => !on.has(s.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ ...s, installed: false }))

  return { ...p, installed, other, orphaned, selectedCount: installed.length + orphaned.length }
}

// ─── What the phone deliberately does NOT edit (named, so a gap reads as a decision)
// Kept as data so the screen can SAY it, the way governance.ts does for its readings.

export const DEFERRED_EDITS_NOTE =
  'Editing the instructions bundle (the AGENTS.md files), uploading a picture, and setting the trust boundary are done on the desk — those are file- and multi-select surfaces a phone can’t do justice. Per-agent permissions are desk-only too (their route isn’t owner-gated server-side — see the design doc).'
