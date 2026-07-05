'use client'
// MCA-80 — budget policies: spend bars (ok/warn/breach) + new-budget dialog.
// Delete is optimistic and owned by the composition root.
import { useState } from 'react'
import { api } from '@/lib/api'
import { tk, space } from '../tokens'
import { Button, Card, IconButton, SectionLabel, Select, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, sx, type Budget, type CAgent, type Getter } from './shared'

function BudgetDialog({ orgId, getToken, agents, onClose, onDone }: { orgId: string; getToken: Getter; agents: CAgent[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ scope: 'company', scopeId: '', limitUsd: '', warnPct: '0.8', hardStop: true })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    if (!f.limitUsd) return
    setBusy(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/budgets`, { token: await getToken(), method: 'POST', body: JSON.stringify({ scope: f.scope, scopeId: f.scope === 'company' ? null : (f.scopeId || null), limitUsd: Number(f.limitUsd), warnPct: Number(f.warnPct), hardStop: f.hardStop }) })
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  return (
    <Modal onClose={onClose}>
      <ModalTitle onClose={onClose}>New budget</ModalTitle>
      <div style={sx.form}>
        <FormLabel>Scope
          <Select value={f.scope} onChange={e => setF({ ...f, scope: e.target.value, scopeId: '' })}>
            <option value="company">Company (all spend)</option>
            <option value="agent">Agent</option>
            <option value="project">Project</option>
            <option value="goal">Goal</option>
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
        {(f.scope === 'project' || f.scope === 'goal') && (
          <FormLabel>{f.scope === 'project' ? 'Project' : 'Goal'} id<TextInput value={f.scopeId} onChange={e => setF({ ...f, scopeId: e.target.value })} /></FormLabel>
        )}
        <div style={{ display: 'flex', gap: space.md }}>
          <FormLabel style={{ flex: 1 }}>Limit (USD)<TextInput type="number" value={f.limitUsd} placeholder="100" onChange={e => setF({ ...f, limitUsd: e.target.value })} /></FormLabel>
          <FormLabel style={{ width: 110 }}>Warn at<TextInput type="number" step="0.05" value={f.warnPct} onChange={e => setF({ ...f, warnPct: e.target.value })} /></FormLabel>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: space.md, fontSize: 12.5, color: tk.textDim }}>
          <input type="checkbox" checked={f.hardStop} onChange={e => setF({ ...f, hardStop: e.target.checked })} /> Hard-stop (pause agents on breach)
        </label>
      </div>
      {err && <div style={sx.err}>⚠ {err}</div>}
      <Button variant="primary" style={{ marginTop: space.md }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Create budget'}</Button>
    </Modal>
  )
}

export default function BudgetsSection({ orgId, getToken, agents, budgets, onDelete, onChanged }: {
  orgId: string; getToken: Getter; agents: CAgent[]; budgets: Budget[]
  onDelete: (id: string) => void; onChanged: () => void
}) {
  const [dlg, setDlg] = useState(false)
  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Budgets</SectionLabel>
        <Button style={{ color: tk.accent }} onClick={() => setDlg(true)}>＋ Budget</Button>
      </div>
      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {budgets.map(b => {
          const c = b.state === 'breach' ? tk.red : b.state === 'warn' ? tk.accent : tk.green
          return (
            <div key={b.id} style={sx.row}>
              <div style={{ minWidth: 130 }}>{b.scope}{b.scopeId ? ` · ${b.scopeId.slice(0, 6)}` : ''}</div>
              <div style={{ flex: 1, height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }} role="progressbar" aria-valuenow={Math.round(b.pct * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ height: '100%', width: `${Math.min(b.pct * 100, 100)}%`, background: c }} />
              </div>
              <div style={{ minWidth: 120, textAlign: 'right', color: c }}>${b.spend.toFixed(2)} / ${b.limitUsd.toFixed(0)}</div>
              <IconButton aria-label={`Delete ${b.scope} budget`} onClick={() => onDelete(b.id)}>✕</IconButton>
            </div>
          )
        })}
        {budgets.length === 0 && <p style={{ ...sx.empty, padding: `${space.md}px 0` }}>No budgets — add a hard-stop to cap spend by company, agent, project, or goal.</p>}
      </Card>
      {dlg && <BudgetDialog orgId={orgId} getToken={getToken} agents={agents} onClose={() => setDlg(false)} onDone={() => { setDlg(false); onChanged() }} />}
    </div>
  )
}
