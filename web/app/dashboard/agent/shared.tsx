'use client'
// Epic AG — shared types + styles for the per-agent detail page (AG1 shell,
// AG2–AG6 tabs). Everything structural comes from tokens.ts; no raw hex here.
import type { CSSProperties } from 'react'
import { tk, text, space } from '../tokens'
import { statusColor, statusIcon } from '../status'

export type Getter = () => Promise<string | null>

/** The `agents` row as the detail page reads it (backend GET /api/agents/:id). */
export type DAgent = {
  id: string
  name: string
  role: string
  title?: string | null
  status: string
  avatarEmoji?: string | null
  /** AG5 — uploaded picture (data URI or URL). Falls back to avatarEmoji when absent. */
  avatarUrl?: string | null
  runtime: string
  llmProvider: string
  llmModel: string
  primaryModel?: string | null
  skills?: string[]
  reportsTo?: string | null
  heartbeatStatus?: string | null
  lastHeartbeatAt?: number | null
  termsOfReference?: string | null
  jobDescription?: string | null
  /** AG7 — the email shown on the staff card (blank → a derived @handle). */
  contactChannel?: string | null
}

/**
 * Agent avatar — the uploaded picture when there is one, else the icon/emoji
 * (AG5 keeps upload optional, so the emoji stays the safe default for every
 * existing agent). `alt` is empty because the name is always rendered next to it.
 */
export function AgentAvatar({ agent, size = 40, radius }: { agent: Pick<DAgent, 'avatarUrl' | 'avatarEmoji' | 'name'>; size?: number; radius?: number }) {
  const r = radius ?? Math.round(size / 4)
  const box: CSSProperties = {
    width: size, height: size, borderRadius: r, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: tk.surfaceHigh, border: `1px solid ${tk.line}`, overflow: 'hidden',
  }
  if (agent.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- data URI / backend blob, not an optimizable static asset
    return <img src={agent.avatarUrl} alt="" style={{ ...box, objectFit: 'cover' }} />
  }
  return <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.55) }}>{agent.avatarEmoji || '🤖'}</span>
}

/**
 * Status pill — icon + text label + color (never color alone; the operator is
 * red-green colorblind, see DESIGN_SYSTEM v2 / status.ts).
 */
export function StatusPill({ status, style }: { status: string; style?: CSSProperties }) {
  const c = statusColor(status)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: space.xs,
      fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700,
      color: c, border: `1px solid ${c}`, borderRadius: tk.r.pill, padding: '2px 9px',
      textTransform: 'capitalize', whiteSpace: 'nowrap', ...style,
    }}>
      <span aria-hidden="true">{statusIcon(status)}</span>{status}
    </span>
  )
}

export const ax: Record<string, CSSProperties> = {
  page: { padding: space.xxl, maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: space.xl },
  crumbs: { display: 'flex', alignItems: 'center', gap: space.sm, fontSize: text.sm.fontSize, color: tk.muted },
  crumbLink: { background: 'transparent', border: 'none', color: tk.muted, cursor: 'pointer', fontSize: text.sm.fontSize, padding: 0 },
  header: { display: 'flex', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' },
  name: { fontSize: 24, fontWeight: 800, margin: 0, letterSpacing: -0.4, color: tk.text },
  role: { fontSize: text.sm.fontSize, color: tk.muted, marginTop: 2 },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm, marginLeft: 'auto', flexWrap: 'wrap' },
  tabbar: { display: 'flex', gap: space.xl, borderBottom: `1px solid ${tk.line}`, overflowX: 'auto' },
  tab: { background: 'transparent', border: 'none', borderBottom: '2px solid transparent', color: tk.muted, cursor: 'pointer', fontSize: text.md.fontSize, fontWeight: 600, padding: `${space.sm}px 0`, whiteSpace: 'nowrap' },
  tabOn: { color: tk.text, borderBottomColor: tk.accent },
  sectionTitle: { fontSize: text.md.fontSize, fontWeight: 700, color: tk.text, margin: 0 },
  empty: { color: tk.muted, fontSize: text.sm.fontSize, margin: 0 },
  err: { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: `${space.sm}px ${space.lg}px`, fontSize: text.md.fontSize },
}
