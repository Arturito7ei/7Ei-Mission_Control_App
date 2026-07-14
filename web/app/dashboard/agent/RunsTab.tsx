'use client'
// Epic AG / AG6 — Runs tab: the agent's run history (left) and the selected run's
// detail + log (right), reusing the AG2 `GET …/agents/:id/runs` endpoint.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Card, Skeleton } from '../ui'
import { sx } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { statusColor, statusIcon } from '../status'
import { ax, type Getter } from './shared'

type Run = {
  id: string
  status: string
  taskId: string | null
  logs: unknown
  tokensUsed: number | null
  costUsd: number | null
  startedAt: string | number | null
  endedAt: string | number | null
}
type LogLine = { t?: number | string; msg?: string }

const ms = (v: string | number | null): number | null => {
  if (v == null) return null
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)
  return Number.isNaN(n) ? null : n
}

const ago = (v: string | number | null) => {
  const t = ms(v)
  if (t == null) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const clock = (v: string | number | null) => {
  const t = ms(v)
  return t == null ? '—' : new Date(t).toISOString().slice(11, 19)
}

const duration = (a: string | number | null, b: string | number | null) => {
  const s = ms(a), e = ms(b)
  if (s == null || e == null) return null
  const secs = Math.max(0, Math.round((e - s) / 1000))
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function parseLogs(logs: unknown): LogLine[] {
  let v: unknown = logs
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  return Array.isArray(v) ? (v as LogLine[]).filter(l => typeof l?.msg === 'string') : []
}

export default function RunsTab({ orgId, agentId, getToken, onOpenTask }: {
  orgId: string
  agentId: string
  getToken: Getter
  onOpenTask?: (taskId: string) => void
}) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const { runs: r } = await api<{ runs: Run[] }>(`/api/orgs/${orgId}/agents/${agentId}/runs?limit=50`, { token: await getToken() })
      setRuns(r)
      setSelected(cur => cur && r.some(x => x.id === cur) ? cur : (r[0]?.id ?? null))
    } catch (e: any) { setErr(e?.message ?? 'Could not load runs.') }
  }, [orgId, agentId, getToken])

  useEffect(() => { load() }, [load])

  if (err && !runs) return <div style={ax.err}>{err}</div>
  if (!runs) return <div style={{ display: 'flex', gap: space.lg }}><Skeleton w={280} h={220} /><Skeleton h={220} /></div>
  if (runs.length === 0) return <Card><p style={ax.empty}>This agent has not run yet. Assign it a task, or run a heartbeat.</p></Card>

  const run = runs.find(r => r.id === selected) ?? runs[0]
  const logs = parseLogs(run.logs)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: space.lg, alignItems: 'start' }}>

      {/* ── Run list ─────────────────────────────────────────────────────── */}
      <Card style={{ padding: 0, overflow: 'hidden', maxHeight: 560, overflowY: 'auto' }}>
        {runs.map((r, i) => {
          const on = r.id === run.id
          return (
            <button key={r.id} onClick={() => setSelected(r.id)} aria-current={on}
              style={{
                display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: `${space.md}px ${space.lg}px`, background: on ? 'var(--accent-dim)' : 'transparent',
                border: 'none', borderTop: i === 0 ? 'none' : `1px solid ${tk.line}`,
                borderLeft: `2px solid ${on ? tk.accent : 'transparent'}`,
              }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: space.sm, width: '100%' }}>
                <span aria-hidden="true" style={{ color: statusColor(r.status), fontWeight: 700, fontSize: text.xs.fontSize }}>{statusIcon(r.status)}</span>
                <code style={{ fontSize: text.xs.fontSize, color: tk.textDim }}>{r.id.slice(0, 8)}</code>
                <span style={{ marginLeft: 'auto', fontSize: text.xs.fontSize, color: tk.muted }}>{ago(r.startedAt)}</span>
              </span>
              <span style={{ fontSize: text.xs.fontSize, color: tk.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>
                {parseLogs(r.logs).at(-1)?.msg ?? `Run ${r.status}.`}
              </span>
            </button>
          )
        })}
      </Card>

      {/* ── Run detail ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
        <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
            <span style={{ color: statusColor(run.status), fontWeight: 700, fontSize: text.sm.fontSize }}>
              <span aria-hidden="true">{statusIcon(run.status)}</span> {run.status}
            </span>
            <code style={{ ...sx.code }}>{run.id}</code>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: space.lg }}>
            <Meta label="Started" value={clock(run.startedAt)} />
            <Meta label="Ended" value={clock(run.endedAt)} />
            <Meta label="Duration" value={duration(run.startedAt, run.endedAt) ?? (run.status === 'running' ? 'running…' : '—')} />
            <Meta label="Tokens" value={run.tokensUsed?.toLocaleString() ?? '—'} />
            <Meta label="Cost" value={run.costUsd != null ? `$${run.costUsd.toFixed(4)}` : '—'} />
          </div>
          {run.taskId && onOpenTask && (
            <button onClick={() => onOpenTask(run.taskId!)}
              style={{ background: 'transparent', border: 'none', color: tk.accent, cursor: 'pointer', fontSize: text.sm.fontSize, fontWeight: 600, padding: 0, alignSelf: 'flex-start' }}>
              Open the task this run worked on →
            </button>
          )}
        </Card>

        <Card style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
          <h3 style={{ ...ax.sectionTitle, fontSize: text.sm.fontSize }}>Log ({logs.length})</h3>
          {logs.length === 0
            ? <p style={ax.empty}>This run recorded no log lines.</p>
            : (
              <pre style={{ ...sx.pre, margin: 0, maxHeight: 380, overflow: 'auto' }}>
                {logs.map((l, i) => `${l.t ? `${clock(l.t as any)}  ` : ''}${l.msg}`).join('\n')}
              </pre>
            )}
        </Card>
      </div>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{label}</span>
      <span style={{ fontSize: text.sm.fontSize, fontWeight: 700, color: tk.text, fontFamily: 'monospace' }}>{value}</span>
    </div>
  )
}
