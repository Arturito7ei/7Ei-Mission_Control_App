// MOB-6f — Connectors' pure half. No React, no react-native, so
// `connectors.test.ts` can load it AND the BACKEND's connector registry
// (`backend/src/services/connectors.ts` — a dependency-free module) under
// `node --test` and assert the phone knows the same connectors the server does.
//
// WHAT CARRIES OVER, AND WHAT DOESN'T
//
// The web's Connectors panel (web/app/dashboard/ConnectorsPanel.tsx, 31KB) is a
// connection MANAGER: per-connector credential forms, token rotation, a "Test"
// button, disconnect, the consolidated Google card with per-service toggles, the
// gear sheets (Google account/calendar/drive scope; vault repo/root/branch), and
// the Jira issue peek.
//
// The phone keeps exactly one thing: WHICH INTEGRATIONS ARE CONNECTED. That's
// the reading an operator away from their desk wants ("is the vault still
// attached?"), and it's the only part of that panel that isn't either a
// credential form or an OAuth redirect.
//
// DEFERRED (not dropped) — parity doc §6.7:
//   * Connect / OAuth. The web's `connect` POSTs a token or bounces through
//     `window.location` to Google's consent screen. Neither belongs on a phone:
//     the first would mean typing a credential into a handset (this app never
//     takes a secret — see auth.tsx), and the second has no `window.location` to
//     redirect. Connecting stays on the desktop, and the screen SAYS so.
//   * Test / disconnect / rotate token / the gear sheets. All writes.
//
// NO SECRET IS EVER READ, LET ALONE RENDERED. The backend's status projection
// (`GET …/connectors`) returns `detail` as an ACCOUNT LABEL — the GitHub/HF
// account name, `email · domain (PROJECT)` for Jira, `repo · root/ (branch)` for
// the vault (backend/src/routes/connectors.ts). The credential itself never
// leaves the encrypted secret store, and the registry's `secretKey` (the NAME of
// the storage key, e.g. `GITHUB_TOKEN`) is deliberately NOT in the row type
// below — the phone has no reason to know even that.

/**
 * One connector row, as `GET …/connectors` returns it: the registry's metadata
 * merged with the org's live status. Field names are the backend's and the
 * web's — one contract, three clients.
 */
export interface ConnectorRowLite {
  id: string
  name: string
  category: string
  authType: 'token' | 'basic' | 'oauth'
  icon: string
  docsUrl: string
  fields: string[]
  connected: boolean
  /** An ACCOUNT LABEL, never a credential. See the header note. */
  detail: string | null
}

/** Said on the screen, not just here: why there are no Connect buttons. */
export const CONNECTORS_READONLY_NOTE =
  'Read-only on the phone. Connecting, testing, and disconnecting are done on the desktop — an OAuth consent flow needs a browser redirect, and this app never asks you to type a credential.'

/**
 * Category display order. COPIED from ConnectorsPanel.tsx's `CATEGORY_ORDER` — a
 * constant inside a JSX component module, so it can't be imported here. The
 * tripwire pins the thing that actually matters instead: that this list COVERS
 * every category the backend registry ships (`connectors.test.ts`). So a new
 * category on the server fails the test rather than silently landing an
 * uncategorised connector at the bottom of the phone's list.
 */
export const CATEGORY_ORDER = ['Memory', 'Project', 'Dev', 'Google', 'AI']

/**
 * Colorblind-safe status — glyph + word + tone, never hue alone (theme.ts). The
 * web uses a Pill whose text already says "Connected"/"Not connected"; the phone
 * adds the glyph because a 390pt row has less room for the word to carry it
 * alone.
 */
export function connectedBadge(row: ConnectorRowLite): {
  icon: string
  label: string
  tone: 'ok' | 'neutral'
} {
  return row.connected
    ? { icon: '✓', label: 'Connected', tone: 'ok' }
    : { icon: '○', label: 'Not connected', tone: 'neutral' }
}

/**
 * The subtitle under a connector's name: its account label when connected, and
 * an honest blank-state when not. Never a credential — `detail` is an account
 * label by the backend's construction (header note).
 */
export function detailLine(row: ConnectorRowLite): string {
  if (!row.connected) return 'Not connected — connect from the desktop.'
  return row.detail?.trim() || 'Connected'
}

/** One section of the list. */
export interface ConnectorGroup {
  category: string
  rows: ConnectorRowLite[]
}

/**
 * Group by category in `CATEGORY_ORDER`, with any UNKNOWN category appended
 * (alphabetically) rather than dropped. Dropping would be the worse failure: a
 * connector the server knows about would silently not exist on the phone. The
 * tripwire makes the unknown case a test failure too, but a runtime that
 * degrades honestly beats one that hides a row.
 */
export function connectorGroups(rows: ConnectorRowLite[]): ConnectorGroup[] {
  const seen = new Map<string, ConnectorRowLite[]>()
  for (const r of rows) {
    const list = seen.get(r.category)
    if (list) list.push(r)
    else seen.set(r.category, [r])
  }
  const known = CATEGORY_ORDER.filter((c) => seen.has(c))
  const unknown = [...seen.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort()
  return [...known, ...unknown].map((category) => ({ category, rows: seen.get(category)! }))
}

/** "3 of 7 connected" — the header line, computed once. */
export function connectedSummary(rows: ConnectorRowLite[]): string {
  const on = rows.filter((r) => r.connected).length
  return `${on} of ${rows.length} connected`
}
