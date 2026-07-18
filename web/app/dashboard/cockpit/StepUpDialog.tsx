'use client'
// APPR-1 — the desk's step-up dialog for APPROVING a dangerous action.
//
// The web mirror of the phone's MOB-4 modal (apps/mobile/src/screens/StepUpModal.tsx),
// reusing the SAME backend contract. Opened only when the operator clicks Approve on
// an approval that needs step-up. It:
//   1. Shows the danger CLEARLY — type + the backend's MACHINE-RENDERED summary +
//      every danger warning (never the model's prose).
//   2. Requires an explicit human gate FIRST: the operator types APPROVE. There is no
//      Face ID in a browser, so typing is the deliberate act — the desk equivalent of
//      the phone's biometric/typed-APPROVE gate. We deliberately do NOT auto-mint a
//      step-up session behind the operator's back: minting silently on their behalf
//      would satisfy the server while defeating the entire point of the gate, which is
//      that a HUMAN consciously re-authorized this specific dangerous action.
//   3. Only AFTER the gate passes: mints a FRESH Arturita session (per approval — never
//      cached or reused across approvals, respecting the backend's 5-min freshness
//      window / 30-min TTL and its single-operator intent) and sends it in the
//      `x-arturita-session` header on the single decide call.
//   4. Surfaces failure VISIBLY and keeps the card — a 403 must never look like success.
//      Re-confirming re-runs the gate AND re-mints, so recovery is never a dead end.
//
// The step-up token lives only inside `submit()` as a local const, is attached to the
// one decide call, and is NEVER logged, stored, or placed in a URL.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, TextInput } from '../ui'
import type { Approval } from './shared'
import { dangerDetails, typedConfirmationOk, TYPED_CONFIRM_WORD } from '@/lib/dangerousApprovals'

export default function StepUpDialog({ approval, orgId, getToken, onCancel, onApproved }: {
  approval: Approval
  orgId: string
  getToken: () => Promise<string | null>
  onCancel: () => void
  onApproved: (id: string) => void
}) {
  const d = dangerDetails(approval)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // ESC closes (a11y convention, MCA-73) — but never mid-flight, so the operator
  // can't dismiss the dialog while a decide call is still in the air.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const submit = useCallback(async () => {
    if (!typedConfirmationOk(typed) || busy) return
    setBusy(true); setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Not signed in — reload and try again.')
      // Fresh session per approval; held only in this local var, never logged.
      const { token: stepUpToken } = await api<{ token: string }>(
        `/api/orgs/${orgId}/arturita/session`,
        { token, method: 'POST', body: JSON.stringify({ source: 'desk' }) },
      )
      await api(`/api/approvals/${approval.id}/decide`, {
        token,
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' }),
        headers: { 'x-arturita-session': stepUpToken },
      })
      onApproved(approval.id) // ONLY here does the card go away
    } catch (e: any) {
      const msg = String(e?.message ?? '')
      // A stale/expired step-up (clock skew, or a dialog left open >5 min) surfaces
      // as 403. Re-confirming re-mints, so this is recoverable in one more type.
      const expired = /\b403\b/.test(msg) || /step-up/i.test(msg)
      setError(expired
        ? 'Step-up expired or was rejected by the server — nothing was approved. Type APPROVE again to retry.'
        : msg || 'Approval failed — nothing was approved. Please try again.')
      setTyped('')
      setBusy(false)
      // Deliberately NOT calling onApproved/onCancel: the card stays, and the
      // operator is told the truth about what the server did.
    }
  }, [typed, busy, getToken, orgId, approval.id, onApproved])

  const ready = typedConfirmationOk(typed)

  return (
    <div style={s.backdrop} role="dialog" aria-modal="true" aria-labelledby="stepup-title" onClick={() => { if (!busy) onCancel() }}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.head}>
          <span style={s.chip}>⚠ {d.typeLabel}</span>
          <span id="stepup-title" style={{ fontWeight: 700 }}>Confirm a dangerous action</span>
        </div>

        {/* The backend's verbatim, machine-rendered summary — never model prose. */}
        <div style={s.summary}>{d.summary}</div>

        {d.warnings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: space.md }}>
            {d.warnings.map((w, i) => <div key={i} style={s.warnLine}>⚠ {w}</div>)}
          </div>
        )}

        <div style={s.explain}>
          Approving this requires step-up. Type <strong>{TYPED_CONFIRM_WORD}</strong> to confirm you
          intend this exact action.
        </div>

        <TextInput
          ref={inputRef}
          value={typed}
          disabled={busy}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && ready) submit() }}
          placeholder={TYPED_CONFIRM_WORD}
          aria-label={`Type ${TYPED_CONFIRM_WORD} to confirm`}
          style={{ width: '100%', marginBottom: space.md }}
        />

        {/* Failure is VISIBLE, in the dialog, next to the action that failed. */}
        {error && <div style={s.errLine} role="alert">{error}</div>}

        <div style={{ display: 'flex', gap: space.md, justifyContent: 'flex-end' }}>
          <Button style={{ color: tk.muted }} disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={submit}>
            {busy ? 'Approving…' : '✓ Confirm approve'}
          </Button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: space.lg },
  sheet: { background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, boxShadow: 'var(--shadow-modal)', padding: space.lg, width: 'min(520px, 100%)', maxHeight: '85vh', overflowY: 'auto' },
  head: { display: 'flex', alignItems: 'center', gap: space.md, marginBottom: space.md },
  chip: { background: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-line)', borderRadius: tk.r.sm, padding: '2px 8px', fontSize: text.xs.fontSize, fontWeight: 700, whiteSpace: 'nowrap' },
  // The machine-rendered action, given visual weight — this is what is being approved.
  summary: { fontWeight: 600, fontFamily: 'ui-monospace, monospace', fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, padding: space.md, marginBottom: space.md, wordBreak: 'break-word' },
  warnLine: { fontSize: text.xs.fontSize, color: 'var(--warning-text)' },
  explain: { fontSize: text.xs.fontSize, color: tk.muted, marginBottom: space.md },
  errLine: { fontSize: text.xs.fontSize, color: 'var(--danger-text)', marginBottom: space.md, fontWeight: 600 },
}
