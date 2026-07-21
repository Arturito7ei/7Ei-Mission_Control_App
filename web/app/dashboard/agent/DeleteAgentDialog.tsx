'use client'
// AAD-2 — the destructive confirmation for "Delete agent".
//
// Deliberately harder to get through than any other dialog on the desk: it names
// what dies (credentials, not just a row), and it requires the agent's NAME to be
// typed. That is the same shape the step-up dialog uses for a dangerous approval
// (APPR-1) — an operator should have to state intent, not just aim a mouse.
//
// HONESTY. The card is NOT cleared optimistically and the caller is NOT told
// "deleted" until the request has actually returned 2xx. This is the APPR-1
// lesson: a 403 that renders as success is worse than a visible failure.
import { useState } from 'react'
import { api } from '@/lib/api'
import { DELETE_CONSEQUENCES, DELETE_TITLE, agentDeletePath, isDeleteConfirmed } from '@/lib/agentDelete'
import { Button, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, sx } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import type { Getter } from './shared'

export default function DeleteAgentDialog({ orgId, agentId, agentName, getToken, onClose, onDeleted }: {
  orgId: string
  agentId: string
  agentName: string
  getToken: Getter
  onClose: () => void
  /** Fired ONLY after the backend confirmed the delete. */
  onDeleted: () => void
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const confirmed = isDeleteConfirmed(typed, agentName)

  const run = async () => {
    if (!confirmed || busy) return
    setBusy(true); setErr(null)
    try {
      await api(agentDeletePath(orgId, agentId), { token: await getToken(), method: 'DELETE' })
      onDeleted() // only on a confirmed 2xx
    } catch (e: any) {
      // 403 (not an owner) / 404 (already gone or not in this org) / network —
      // say which, and keep the dialog open. Nothing has been removed on screen.
      setErr(e?.message ?? 'The delete failed — nothing was changed.')
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <ModalTitle onClose={onClose}>{DELETE_TITLE}</ModalTitle>

      <p style={sx.hint}>
        <b>{agentName}</b> will be removed from this organisation. This cannot be undone from the app.
      </p>

      <ul style={{ margin: `${space.md}px 0`, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: space.sm }}>
        {DELETE_CONSEQUENCES.map(c => (
          <li key={c} style={{ fontSize: text.sm.fontSize, color: tk.textDim, lineHeight: 1.5 }}>{c}</li>
        ))}
      </ul>

      {err && <div style={sx.err}>⚠ {err}</div>}

      <FormLabel style={{ marginTop: space.md }}>
        {/* One line: FormLabel lays its children out in a column, so a bare
            `Type <b>{name}</b> to confirm` breaks across three rows. */}
        <span>Type <b style={{ color: tk.text }}>{agentName}</b> to confirm</span>
        <TextInput autoFocus value={typed} placeholder={agentName} aria-label={`Type ${agentName} to confirm deletion`}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && confirmed) run() }} />
      </FormLabel>

      <div style={{ display: 'flex', gap: space.sm, justifyContent: 'flex-end', marginTop: space.lg }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={run} disabled={!confirmed || busy}>
          {busy ? 'Deleting…' : 'Delete agent'}
        </Button>
      </div>
    </Modal>
  )
}
