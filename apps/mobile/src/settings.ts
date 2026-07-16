// MOB-6f — Settings' pure half. No React, no react-native, so `settings.test.ts`
// can load it under `node --test` alongside the backend's org schema.
//
// HONEST SCOPE NOTE — THIS SURFACE IS MOSTLY WRITE-ONLY ON THE WEB.
//
// The web's Settings tab (web/app/dashboard/page.tsx, `tab === 'settings'`) is a
// FORM and almost nothing else: three inputs (Description, Mission & Vision,
// Culture & Principles), a per-field "📎 Upload file" chip that summarises a
// document into that field, and a Save button. Its only *reading* is the current
// value of those three fields, which arrive with the org itself:
//
//   GET /api/orgs  → { orgs: [{ id, name, description, mission, culture }] }
//
// So the phone's Settings is small BY THE WEB'S SHAPE, not by our trimming. It
// renders the org's identity and those three fields as prose. That is genuinely
// worth having — Mission & Culture are read by every agent, so "what did we tell
// them we are?" is a real question to answer from a phone — but it is a short
// screen, and it should be. We did not pad it to look like a peer of Governance.
//
// DEFERRED (not dropped) — parity doc §6.7: editing the three fields
// (`PATCH /api/orgs/:id`) and the document-summarise upload
// (`POST …/knowledge/ingest-file`, multipart).
//
// ⚠ THE ORG PAYLOAD CONTAINS A CREDENTIAL. `GET /api/orgs` is
// `db.select().from(organisations)` (backend/src/routes/orgs.ts) — the WHOLE
// row, and that row has a `telegramBotToken` column (backend/src/db/schema.ts).
// The phone has received this payload since MOB-1 (ConnectScreen lists orgs with
// it); MOB-6f does not change that, and fixing it is a BACKEND narrowing that is
// out of scope for an apps/mobile-only story — it's reported as a follow-up.
//
// What that means HERE is a hard rule: this screen renders an ALLOW-LIST
// (`SETTINGS_FIELDS`), never a spread of the org object, never a key walk, and
// nothing is logged. `OrgSettingsLite` deliberately types only the five harmless
// fields, so a stray `{...org}` in a future edit doesn't typecheck its way into
// rendering a token. `settings.test.ts` asserts the hazard column is real AND
// that the allow-list excludes it.
//
// NO SECRETS ARE RENDERED. Worth stating precisely, because
// the nav model lists `secrets` and `adapters` as tabs "hosted" on Settings:
// that bookkeeping mirrors the web's IA intent, but the web's Settings tab does
// NOT in fact render either one — Secrets is its own surface (fed by
// `…/secrets`, rendered inside the Cockpit shell) and Adapters is an unbuilt
// placeholder on every client. Neither is in this screen's scope, and this
// module deliberately reads NOTHING from either endpoint. `SETTINGS_FIELDS`
// below is the complete list of what the screen can show, and
// `assertNoSensitiveField` (pinned by the test) keeps it that way: if someone
// later adds a field whose name smells like a credential, the test fails rather
// than the phone quietly rendering it.

/**
 * The org as Settings reads it. A subset of `GET /api/orgs` — superset-tolerant,
 * so the columns this screen doesn't show simply aren't typed. All four fields
 * are operator-authored PROSE (backend/src/db/schema.ts: `orgs.description`,
 * `.mission`, `.culture` are plain `text` columns).
 */
export interface OrgSettingsLite {
  id: string
  name: string
  description?: string | null
  mission?: string | null
  culture?: string | null
}

/** Said on the screen, not just here: why there are no inputs. */
export const SETTINGS_READONLY_NOTE =
  'Read-only on the phone. Editing your description, mission, and culture — and summarising a document into a field — are done on the desktop.'

/** Why the screen is short. Rendered, so the operator isn't left hunting. */
export const SETTINGS_SCOPE_NOTE =
  'Mission and Culture are read by every agent. Secrets are not shown here on any client — they live on their own surface, and the phone never displays a value.'

export type SettingsFieldKey = 'description' | 'mission' | 'culture'

export interface SettingsField {
  key: SettingsFieldKey
  /** The web's own labels, verbatim (page.tsx). */
  label: string
  /** The web's textarea placeholder, verbatim — the empty state should match. */
  empty: string
}

/**
 * The COMPLETE set of org fields this screen renders, in the web's order. The
 * labels are copied from `page.tsx`, where they're inline JSX — not importable,
 * so not import-tripwirable. `settings.test.ts` pins what CAN be pinned: that
 * every key here is a real `orgs` column, and that none of them is sensitive.
 */
export const SETTINGS_FIELDS: SettingsField[] = [
  { key: 'description', label: 'Description', empty: 'No description set.' },
  { key: 'mission', label: 'Mission & Vision', empty: 'What you’re building and why.' },
  { key: 'culture', label: 'Culture & Principles', empty: 'How your org works.' },
]

/**
 * Anything whose NAME suggests a credential. Deliberately broad and matched
 * against the field list at test time — a false positive costs one conversation,
 * a false negative renders a secret on a phone screen.
 */
export const SENSITIVE_NAME_RE = /token|secret|key|password|passwd|credential|apikey|auth/i

/**
 * Throws if a field list contains anything credential-shaped. Called by the test
 * against `SETTINGS_FIELDS`, so adding (say) `llmApiKey` to this screen fails CI
 * instead of shipping. It's a guard on the FIELD LIST, not a runtime mask —
 * because the right answer for this screen is that a secret never enters it at
 * all, not that we redact one on the way out.
 */
export function assertNoSensitiveField(fields: { key: string; label: string }[]): void {
  for (const f of fields) {
    if (SENSITIVE_NAME_RE.test(f.key) || SENSITIVE_NAME_RE.test(f.label)) {
      throw new Error(
        `[MOB-6f] Settings must not render a credential-shaped field: "${f.key}" (${f.label}). ` +
          'The phone shows org prose only; secrets never reach this screen.',
      )
    }
  }
}

/** The org's value for a field, or null when unset — the screen shows `empty`. */
export function fieldValue(org: OrgSettingsLite, key: SettingsFieldKey): string | null {
  const v = org[key]
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length ? s : null
}

/** Pick the org this session is scoped to. Null when it isn't in the list. */
export function findOrg(orgs: OrgSettingsLite[], orgId: string | null): OrgSettingsLite | null {
  if (!orgId) return null
  return orgs.find((o) => o.id === orgId) ?? null
}
