'use client'
// MCA-80 — scoped secret store (masked values) + new-secret dialog.
// Delete is optimistic and owned by the composition root.
import { useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, IconButton, SectionLabel, Select, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, sx, type CAgent, type Getter, type Secret } from './shared'

function SecretDialog({ orgId, getToken, agents, onClose, onDone }: { orgId: string; getToken: Getter; agents: CAgent[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ scope: 'company', scopeId: '', key: '', value: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    if (!f.key.trim() || !f.value) return
    setBusy(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/secrets`, { token: await getToken(), method: 'POST', body: JSON.stringify({ scope: f.scope, scopeId: f.scope === 'agent' ? (f.scopeId || null) : null, key: f.key.trim(), value: f.value }) })
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  return (
    <Modal onClose={onClose}>
      <ModalTitle onClose={onClose}>New secret</ModalTitle>
      <p style={sx.hint}>Stored AES-256-GCM encrypted. Runtimes fetch scoped secrets via the agent API — never injected into prompts.</p>
      <div style={sx.form}>
        <FormLabel>Scope
          <Select value={f.scope} onChange={e => setF({ ...f, scope: e.target.value, scopeId: '' })}>
            <option value="company">Company (all agents)</option>
            <option value="agent">Agent</option>
          </Select>
        </FormLabel>
        {f.scope === 'agent' && (
          <FormLabel>Agent
            <Select value={f.scopeId} onChange={e => setF({ ...f, scopeId: e.target.value })}>
              <option value="">— pick —</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </FormLabel>
        )}
        <FormLabel>Key<TextInput value={f.key} placeholder="OPENAI_API_KEY" onChange={e => setF({ ...f, key: e.target.value })} /></FormLabel>
        <FormLabel>Value<TextInput type="password" value={f.value} placeholder="sk-…" onChange={e => setF({ ...f, value: e.target.value })} /></FormLabel>
      </div>
      {err && <div style={sx.err}>⚠ {err}</div>}
      <Button variant="primary" style={{ marginTop: space.md }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Store secret'}</Button>
    </Modal>
  )
}

export default function SecretsSection({ orgId, getToken, agents, secrets, onDelete, onChanged }: {
  orgId: string; getToken: Getter; agents: CAgent[]; secrets: Secret[]
  onDelete: (id: string) => void; onChanged: () => void
}) {
  const [dlg, setDlg] = useState(false)
  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Secrets</SectionLabel>
        <Button style={{ color: tk.accent }} onClick={() => setDlg(true)}>＋ Secret</Button>
      </div>
      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {secrets.map(sec => (
          <div key={sec.id} style={sx.row}>
            <span style={sx.badge}>🔒 {sec.scope}{sec.scopeId ? ` · ${sec.scopeId.slice(0, 6)}` : ''}</span>
            <div style={{ flex: 1, fontWeight: 600 }}>{sec.key}</div>
            <code style={{ fontSize: text.sm.fontSize, color: tk.muted }}>{sec.masked}</code>
            <IconButton aria-label={`Delete secret ${sec.key}`} onClick={() => onDelete(sec.id)}>✕</IconButton>
          </div>
        ))}
        {secrets.length === 0 && <p style={{ ...sx.empty, padding: `${space.md}px 0` }}>No secrets — store API keys here; runtimes fetch them scoped, never via prompts.</p>}
      </Card>
      {dlg && <SecretDialog orgId={orgId} getToken={getToken} agents={agents} onClose={() => setDlg(false)} onDone={() => { setDlg(false); onChanged() }} />}
    </div>
  )
}
