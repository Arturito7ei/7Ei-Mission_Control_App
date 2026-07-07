'use client'
// MCA-84 V3 — per-wake preflight cap + model config audit. Two levers surfaced
// in one card: (1) an editable org-wide per-wake cost ceiling — a wake whose
// worst-case cost (full context + a full completion at the model's rates) would
// exceed it is skipped and the task parked for review; (2) a per-agent audit of
// whether each model is priced (spend trackable/cappable) and within the "cheap"
// output-rate threshold. Colorblind-safe: warnings are ⚠-iconed + amber, never
// colour alone; the cap CTA is accent (never red).
import { useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel, TextInput } from '../ui'
import { sx, type Getter, type Preflight } from './shared'

const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

export default function PreflightSection({ orgId, getToken, preflight, onChanged }: {
  orgId: string; getToken: Getter; preflight: Preflight | null; onChanged: () => void
}) {
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!preflight) return null

  const save = async (clear = false) => {
    const capUsd = clear ? null : Number(cap)
    if (!clear && (!Number.isFinite(capUsd) || (capUsd as number) <= 0)) { setErr('Enter a positive dollar amount.'); return }
    setBusy(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/preflight`, { token: await getToken(), method: 'PUT', body: JSON.stringify({ capUsd }) })
      setCap(''); onChanged()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }

  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Preflight & model config</SectionLabel>
        {preflight.warnCount > 0 && (
          <span style={{ ...sx.tag, background: 'var(--warn-bg)', color: tk.amber }}>⚠ {preflight.warnCount} to review</span>
        )}
      </div>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        {/* Per-wake cap — org-wide ceiling on the worst-case cost of a single wake */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
          <span style={{ fontSize: text.sm.fontSize, color: tk.textDim, fontWeight: 600 }}>Per-wake cap</span>
          <span style={{ fontSize: text.sm.fontSize, color: preflight.capUsd == null ? tk.muted : tk.accent, fontWeight: 700 }}>
            {preflight.capUsd == null ? 'none' : usd(preflight.capUsd)}
          </span>
          <div style={{ flex: 1 }} />
          <TextInput type="number" step="0.05" value={cap} placeholder="0.50" aria-label="Per-wake cap in USD"
            onChange={e => setCap(e.target.value)} style={{ width: 90 }} />
          <Button variant="primary" disabled={busy} onClick={() => save(false)}>{busy ? '…' : 'Set cap'}</Button>
          {preflight.capUsd != null && <Button disabled={busy} onClick={() => save(true)}>Clear</Button>}
        </div>
        <p style={sx.hint}>A wake whose worst-case cost would exceed the cap is skipped and the task parked for review. Leave unset for no cap.</p>
        {err && <div style={sx.err}>⚠ {err}</div>}

        {/* Per-agent model audit */}
        <div style={{ borderTop: `1px solid ${tk.line}`, paddingTop: space.md, display: 'flex', flexDirection: 'column' }}>
          {preflight.agents.map(a => (
            <div key={a.agentId} style={sx.row}>
              <span title={a.level === 'warn' ? 'review' : 'ok'} aria-label={a.level === 'warn' ? 'review' : 'ok'}
                style={{ color: a.level === 'warn' ? tk.amber : tk.green, fontWeight: 700, minWidth: 14 }}>
                {a.level === 'warn' ? '⚠' : '✓'}
              </span>
              <span style={{ minWidth: 130, fontWeight: 600, color: tk.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agentName}</span>
              <code style={sx.code}>{a.model}</code>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: text.xs.fontSize, color: tk.muted, minWidth: 130, textAlign: 'right' }}>
                {a.estMaxWakeCostUsd == null
                  ? 'unpriced'
                  : `≤ ${usd(a.estMaxWakeCostUsd)} / wake`}
              </span>
            </div>
          ))}
          {preflight.agents.length === 0 && <p style={{ ...sx.empty, padding: `${space.md}px 0` }}>No agents yet.</p>}
        </div>
        {preflight.agents.some(a => a.issues.length > 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
            {preflight.agents.filter(a => a.issues.length > 0).map(a => (
              <p key={a.agentId} style={{ ...sx.hint, color: tk.amber }}>⚠ {a.agentName}: {a.issues.join(' ')}</p>
            ))}
          </div>
        )}
        <p style={sx.hint}>Cheap threshold: ${preflight.cheapThresholdUsdPerMTok.toFixed(2)}/M output tokens. Models above it — or with no pricing entry (spend can’t be capped) — are flagged.</p>
      </Card>
    </div>
  )
}
