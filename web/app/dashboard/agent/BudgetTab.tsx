'use client'
// Epic AG / AG6 — Budget tab: this agent's cap and spend. A per-agent cap is a
// scoped budget policy, so the hard-stop the executor already enforces is the
// same number shown here — nothing new to keep in sync.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button, Card, Skeleton, TextInput } from '../ui'
import { tk, text, space } from '../tokens'
import { ax, type Getter } from './shared'

type Budget = {
  observedUsd: number
  limitUsd: number | null
  hardStop: boolean
  warnPct: number
  state: 'ok' | 'warn' | 'breach'
  pct: number | null
  remainingUsd: number | null
  health: 'healthy' | 'warning' | 'breached'
}

// Health chip: icon + label + color — the color never carries the meaning alone.
const HEALTH: Record<Budget['health'], { icon: string; label: string; color: string }> = {
  healthy: { icon: '✓', label: 'HEALTHY', color: 'var(--ok)' },
  warning: { icon: '⚠', label: 'APPROACHING CAP', color: 'var(--warn)' },
  breached: { icon: '⛔', label: 'OVER BUDGET', color: 'var(--danger-text)' },
}

export default function BudgetTab({ orgId, agentId, agentName, getToken }: {
  orgId: string
  agentId: string
  agentName: string
  getToken: Getter
}) {
  const [budget, setBudget] = useState<Budget | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const base = `/api/orgs/${orgId}/agents/${agentId}/budget`

  const load = useCallback(async () => {
    setErr(null)
    try {
      const { budget: b } = await api<{ budget: Budget }>(base, { token: await getToken() })
      setBudget(b)
      setDraft(b.limitUsd != null ? String(b.limitUsd) : '')
    } catch (e: any) { setErr(e?.message ?? 'Could not load the budget.') }
  }, [base, getToken])

  useEffect(() => { load() }, [load])

  const save = async () => {
    const trimmed = draft.trim()
    const limitUsd = trimmed === '' ? null : Number(trimmed)
    if (limitUsd != null && (!Number.isFinite(limitUsd) || limitUsd < 0)) { setErr('Enter a positive amount, or leave it blank for no cap.'); return }
    setBusy(true); setErr(null); setSaved(false)
    try {
      const { budget: b } = await api<{ budget: Budget }>(base, { token: await getToken(), method: 'PUT', body: JSON.stringify({ limitUsd }) })
      setBudget(b); setSaved(true)
      setDraft(b.limitUsd != null ? String(b.limitUsd) : '')
    } catch (e: any) { setErr(e?.message ?? 'Could not set the budget.') }
    setBusy(false)
  }

  if (err && !budget) return <div style={ax.err}>{err}</div>
  if (!budget) return <Skeleton h={220} />

  const h = HEALTH[budget.health]
  const pct = budget.pct == null ? 0 : Math.min(budget.pct * 100, 100)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xl }}>
      {err && <div style={ax.err}>{err}</div>}

      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted, letterSpacing: 0.6, textTransform: 'uppercase' }}>Agent</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: tk.text }}>{agentName}</div>
            <div style={{ fontSize: text.sm.fontSize, color: tk.muted, marginTop: 2 }}>All-time spend against this agent’s cap</div>
          </div>
          <span style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: space.xs,
            fontSize: text.xs.fontSize, fontWeight: 700, letterSpacing: 0.6,
            color: h.color, border: `1px solid ${h.color}`, borderRadius: tk.r.pill, padding: '2px 9px',
          }}>
            <span aria-hidden="true">{h.icon}</span>{h.label}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: space.xl }}>
          <div>
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted, letterSpacing: 0.6, textTransform: 'uppercase' }}>Observed</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: tk.text, lineHeight: 1.2 }}>${budget.observedUsd.toFixed(2)}</div>
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{budget.limitUsd == null ? 'No cap configured' : `of $${budget.limitUsd.toFixed(2)}`}</div>
          </div>
          <div>
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted, letterSpacing: 0.6, textTransform: 'uppercase' }}>Budget</div>
            {/* No policy = unlimited, NOT a zero budget. Say so plainly. */}
            <div style={{ fontSize: 26, fontWeight: 800, color: budget.limitUsd == null ? tk.muted : tk.text, lineHeight: 1.2 }}>
              {budget.limitUsd == null ? 'Disabled' : `$${budget.limitUsd.toFixed(2)}`}
            </div>
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted }}>
              {budget.limitUsd == null ? 'Spend is not capped for this agent' : `Soft alert at ${Math.round(budget.warnPct * 100)}%${budget.hardStop ? ' · hard stop at the cap' : ''}`}
            </div>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: text.xs.fontSize, color: tk.muted, marginBottom: space.xs }}>
            <span>Remaining</span>
            <span>{budget.remainingUsd == null ? 'Unlimited' : `$${budget.remainingUsd.toFixed(2)}`}</span>
          </div>
          <div style={{ height: 6, background: tk.surfaceHigh, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: h.color, borderRadius: 3 }} />
          </div>
        </div>
      </Card>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <label style={{ fontSize: text.xs.fontSize, color: tk.muted, letterSpacing: 0.6, textTransform: 'uppercase' }} htmlFor="agent-budget">Budget (USD)</label>
        <div style={{ display: 'flex', gap: space.md, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextInput id="agent-budget" value={draft} placeholder="0.00" inputMode="decimal" style={{ flex: 1, minWidth: 180 }}
            onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save() }} />
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Set budget'}</Button>
          {saved && <span style={{ color: tk.green, fontSize: text.sm.fontSize }}>✓ Saved</span>}
        </div>
        <p style={{ ...ax.empty, fontSize: text.xs.fontSize }}>
          Leave blank (or set 0) for no cap. With a cap and hard-stop on, the agent is paused and its queued tasks are
          parked when the cap is reached — the same enforcement the executor already applies.
        </p>
      </Card>
    </div>
  )
}
