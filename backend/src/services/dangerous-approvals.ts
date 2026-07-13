// Arturita A2 — dangerous-action approval types + step-up gate.
//
// Extends the existing tri-state approval flow (`governance.ts` [APPROVAL:…] +
// `approvals.ts`) with the four Arturita danger types and two guarantees:
//
//  1. **Machine-regenerated, verbatim action summary.** For a dangerous approval
//     the card MUST show a summary rendered *deterministically from structured
//     action fields* — never the model's prose. `renderActionSummary()` is that
//     renderer; the route stores its output and ignores any model-supplied text.
//     The human approves the concrete action, not a paraphrase (PRD §6, §7.2).
//  2. **Step-up.** Approving a dangerous action requires a *fresh* command
//     session (A1's `isFresh`). `evaluateStepUp()` encodes the rule; the route
//     resolves session freshness and passes it into `decideApproval`.
//
// Pure helpers only (string formatting + arithmetic); the route does the IO.

export const DANGEROUS_APPROVAL_TYPES = [
  'file_destructive',
  'wallet_tx',
  'email_send',
  'machine_exec',
] as const
export type DangerousApprovalType = (typeof DANGEROUS_APPROVAL_TYPES)[number]

/** Is this approval type one of Arturita's dangerous surfaces (needs step-up +
 *  a machine-rendered summary)? Case/space-normalized to match how
 *  `parseApprovalDirectives` emits types. */
export function isDangerousType(type: string | null | undefined): type is DangerousApprovalType {
  const t = String(type ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  return (DANGEROUS_APPROVAL_TYPES as readonly string[]).includes(t)
}

/** Dangerous approvals require step-up before they can be *approved*. (Reject and
 *  revision-requested never need step-up — you can always decline without one.) */
export function requiresStepUp(type: string | null | undefined): boolean {
  return isDangerousType(type)
}

// ─── Human-readable byte / list formatting ───────────────────────────────────

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Format a byte count for the approval card (e.g. 1288490188 → "1.2 GB"). */
export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let i = 0
  let v = n
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  const s = v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)
  return `${s} ${UNITS[i]}`
}

function asList(v: string | string[] | null | undefined): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
  const s = String(v ?? '').trim()
  return s ? [s] : []
}

// ─── The four renderers ──────────────────────────────────────────────────────

export interface RenderResult {
  ok: boolean
  summary?: string
  error?: string
  /** The danger flags (external recipient, unlimited approval, …) surfaced on the card. */
  warnings?: string[]
}

const FILE_OPS = ['move', 'delete', 'overwrite', 'trash'] as const

function renderFileDestructive(a: any): RenderResult {
  const op = String(a?.op ?? '').toLowerCase()
  if (!(FILE_OPS as readonly string[]).includes(op)) {
    return { ok: false, error: `file_destructive requires op ∈ {${FILE_OPS.join('|')}}` }
  }
  const count = Number(a?.count)
  if (!Number.isFinite(count) || count < 0) return { ok: false, error: 'file_destructive requires a numeric count' }
  const size = a?.bytes != null ? ` (${formatBytes(a.bytes)})` : ''
  const noun = count === 1 ? 'item' : 'items'
  const from = a?.root ? ` from ${a.root}` : ''
  const warnings: string[] = []
  if (op === 'delete') warnings.push('Permanent delete — originals staged in the undo journal for the reversible window.')
  if (count > 0 && a?.recursive) warnings.push('Recursive operation.')
  let summary: string
  if (op === 'move') {
    if (!a?.dest) return { ok: false, error: 'file_destructive move requires a dest' }
    summary = `Move ${count} ${noun}${size}${from} → ${a.dest}`
  } else if (op === 'overwrite') {
    summary = `Overwrite ${count} ${noun}${size}${from}`
  } else if (op === 'trash') {
    summary = `Move ${count} ${noun}${size}${from} → Trash`
  } else {
    summary = `Delete ${count} ${noun}${size}${from}`
  }
  return { ok: true, summary, warnings }
}

function renderWalletTx(a: any): RenderResult {
  const chain = String(a?.chain ?? '').trim()
  if (!chain) return { ok: false, error: 'wallet_tx requires a chain' }
  // `decoded` is the plain-language decode produced upstream (E1). A2 formats it
  // deterministically with the destination + label; it does not itself decode.
  const decoded = String(a?.decoded ?? '').trim()
  if (!decoded) return { ok: false, error: 'wallet_tx requires a decoded human-readable summary' }
  const to = a?.to ? ` → ${a.to}` : ''
  const label = a?.contractLabel ? ` · ${a.contractLabel}` : ''
  const summary = `[${chain}] ${decoded}${to}${label}`
  const warnings: string[] = []
  if (a?.newAddress) warnings.push('Destination is a never-before-seen address.')
  if (a?.setApprovalForAll) warnings.push('setApprovalForAll — grants control of ALL tokens in a collection.')
  if (a?.unlimitedApproval) warnings.push('Unlimited token approval — the spender can move any amount.')
  if (a?.drainPattern) warnings.push('Calldata matches a known drain pattern.')
  if (a?.unknownContract) warnings.push('Destination contract is unknown / unlabeled.')
  if (a?.overCap) warnings.push('Exceeds a per-tx or per-day cap — step-up required.')
  return { ok: true, summary, warnings }
}

function renderEmailSend(a: any): RenderResult {
  const to = asList(a?.to)
  if (to.length === 0) return { ok: false, error: 'email_send requires at least one recipient' }
  const subject = String(a?.subject ?? '').trim()
  if (!subject) return { ok: false, error: 'email_send requires a subject' }
  const size = a?.bodyBytes != null ? ` (${formatBytes(a.bodyBytes)} body)` : ''
  const recips = to.length <= 3 ? to.join(', ') : `${to.slice(0, 3).join(', ')} +${to.length - 3} more`
  const summary = `Send email to ${recips} — "${subject}"${size}`
  const warnings: string[] = []
  if (a?.external) warnings.push('External recipient(s).')
  if (a?.replyAll) warnings.push('Reply-all.')
  const att = Number(a?.attachments)
  if (Number.isFinite(att) && att > 0) warnings.push(`${att} attachment${att === 1 ? '' : 's'}.`)
  if (a?.secretPattern) warnings.push('Body matches a secret pattern (key/seed) — refused without explicit override.')
  return { ok: true, summary, warnings }
}

function renderMachineExec(a: any): RenderResult {
  const argv = Array.isArray(a?.argv) ? a.argv.map((x: unknown) => String(x)) : null
  if (!argv || argv.length === 0) return { ok: false, error: 'machine_exec requires a non-empty argv array' }
  // argv is shown VERBATIM (no shell string), so the human sees exactly what runs.
  const cwd = a?.cwd ? ` (cwd: ${a.cwd})` : ''
  const summary = `Run: ${argv.join(' ')}${cwd}`
  const warnings: string[] = []
  if (a?.allowlisted === false) warnings.push('Command is NOT on the allowlist — one-off approval only.')
  return { ok: true, summary, warnings }
}

/** Render the verbatim, machine-generated approval summary for a dangerous type
 *  from its structured action payload. Fail-closed: unknown type or missing
 *  required fields → `{ ok:false, error }` so the route 400s rather than fall
 *  back to model prose. */
export function renderActionSummary(type: string, action: any): RenderResult {
  const t = String(type ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  switch (t) {
    case 'file_destructive': return renderFileDestructive(action)
    case 'wallet_tx':        return renderWalletTx(action)
    case 'email_send':       return renderEmailSend(action)
    case 'machine_exec':     return renderMachineExec(action)
    default:                 return { ok: false, error: `not a dangerous approval type: ${type}` }
  }
}

// ─── Approval-record preparation (shared by the human + agent routes) ─────────

export interface PreparedApproval {
  ok: boolean
  error?: string
  /** machine-rendered summary (dangerous) or the caller's summary (safe) */
  summary?: string
  /** the row's payload — { action, warnings, requiresStepUp } for dangerous types */
  payload?: any
  warnings?: string[]
}

/**
 * Prepare an `approval_requests` row's summary + payload, enforcing the A2 rule
 * that a DANGEROUS approval's summary is machine-rendered VERBATIM from the
 * structured `action` (never client/model prose) and is fail-closed on a bad
 * payload. For `machine_exec` this means the human always sees the exact `argv`,
 * whether the approval was filed by a human route or by an external runtime
 * (e.g. the Claude Code adapter proposing a command — CC2).
 *
 * Non-dangerous types keep the caller-supplied summary + payload unchanged.
 * The dangerous payload always carries `requiresStepUp:true` so the decide route
 * demands a fresh command session to approve.
 */
export function prepareApprovalRecord(input: {
  type: string
  summary?: string | null
  action?: any
  payload?: any
}): PreparedApproval {
  if (isDangerousType(input.type)) {
    const action = input.action ?? (input.payload && input.payload.action)
    const rendered = renderActionSummary(input.type, action)
    if (!rendered.ok) return { ok: false, error: `dangerous approval: ${rendered.error}` }
    return {
      ok: true,
      summary: rendered.summary,
      warnings: rendered.warnings,
      payload: { action, warnings: rendered.warnings ?? [], requiresStepUp: true },
    }
  }
  if (!input.summary) return { ok: false, error: 'type and summary are required' }
  return { ok: true, summary: input.summary, payload: input.payload ?? null }
}

// ─── Step-up gate ────────────────────────────────────────────────────────────

export interface StepUpEvaluation {
  ok: boolean
  error?: string
}

/** Decide whether a decision is allowed given the step-up state. Only *approving*
 *  a dangerous type is gated; reject / revision_requested pass through. A
 *  non-dangerous type is never gated. */
export function evaluateStepUp(input: {
  type: string | null | undefined
  decision: string
  sessionFresh: boolean
}): StepUpEvaluation {
  if (input.decision !== 'approved') return { ok: true }
  if (!requiresStepUp(input.type)) return { ok: true }
  if (input.sessionFresh) return { ok: true }
  return {
    ok: false,
    error:
      'step-up required: approving a dangerous action (' +
      String(input.type) +
      ') needs a fresh command session — re-authenticate and retry.',
  }
}
