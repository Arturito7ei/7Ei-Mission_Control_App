'use client'
// MCA-80 — shared types, domain constants, and modal scaffolding for the
// cockpit sections. MCA-86: domain colors re-pointed at the theme-map CSS
// variables (DESIGN_SYSTEM v2) — heartbeat green now renders as ACTIVE PURPLE
// (colorblind rule: active ≠ green), stale as failed red; raw hex lives only
// in tokens.ts. Everything structural comes from tokens.
import type { CSSProperties, ReactNode } from 'react'
import { tk, density, text, space } from '../tokens'

export type Getter = () => Promise<string | null>

export type CAgent = {
  id: string; name: string; role: string; runtime: string; llmProvider: string; llmModel: string
  status: string; agentType: string; avatarEmoji: string; heartbeat: string; lastHeartbeatAt: number | null
}
export type CTask = { id: string; title: string; status: string; kanbanColumn: string; priority: string; agentId: string }
export type Cockpit = { agents: CAgent[]; tasks: CTask[]; summary: Record<string, number>; generatedAt: string }
export type OrgNode = { id: string; name: string; role: string; title?: string | null; runtime?: string; avatarEmoji?: string | null; status?: string; children: OrgNode[] }
export type InboxItem = { taskId: string; title: string; kind: string; priority: string; agentName: string; agentEmoji: string }
export type GoalNode = { id: string; title: string; metric?: string | null; status?: string; children: GoalNode[] }
export type Approval = { id: string; type: string; summary: string; status: string; requestedByAgentId?: string | null }
export type Budget = { id: string; scope: string; scopeId?: string | null; limitUsd: number; spend: number; state: string; pct: number }
export type Secret = { id: string; scope: string; scopeId?: string | null; key: string; masked: string }
export type Workspace = { id: string; name: string; repoUrl?: string | null; baseBranch?: string | null; previewUrl?: string | null }
export type Plugin = { id: string; name: string; version: string; enabled: boolean; capabilities: string[]; tools: string[]; description?: string | null }

// Heartbeat → status table: green = running → active (purple), amber → paused,
// stale → failed. Pair with statusIcon() — never a color-only dot.
export const HB: Record<string, string> = { green: 'var(--accent)', amber: 'var(--warn)', stale: 'var(--danger-text)', unknown: 'var(--muted)' }
export const RUNTIME_BADGE: Record<string, string> = { internal: '🧠', openclaw: '📎', cursor: '⌨️', claude_code: '🤖', custom: '⚙️' }
export const PRI_C: Record<string, string> = { high: 'var(--danger-text)', medium: 'var(--warn)', low: 'var(--muted)' }
// Inbox kinds carry their icon in the label (⛔/✕ always accompany red).
export const KIND_LABEL: Record<string, string> = { blocked: '⛔ Blocked', failed: '✕ Failed', review: 'Review', attention: 'ℹ Attention' }
export const KIND_C: Record<string, { bg: string; fg: string }> = {
  blocked: { bg: 'var(--danger-bg)', fg: 'var(--danger-text)' }, failed: { bg: 'var(--danger-bg)', fg: 'var(--danger-text)' },
  review: { bg: 'var(--warn-bg)', fg: 'var(--warn)' }, attention: { bg: 'var(--info-bg)', fg: 'var(--info)' },
}
// Agent-identity purple (external/BYO chips) — mode-stable Aztec, stays purple.
export const EXT_PURPLE = 'var(--purple-1)'

// Shared cockpit styles — dense list rows (flex siblings of ui.tsx's grid
// DenseRow, same 28px density scale) and the bits every dialog/section reuses.
export const sx: Record<string, CSSProperties> = {
  row: { display: 'flex', alignItems: 'center', gap: space.lg, boxSizing: 'border-box', minHeight: density.row, padding: `${density.cellY}px 0`, borderBottom: `1px solid ${tk.lineSoft}`, fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight },
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  tag: { fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700, borderRadius: tk.r.pill, padding: '1px 8px', whiteSpace: 'nowrap' },
  badge: { fontSize: text.xs.fontSize, color: tk.textDim, background: tk.surfaceHigh, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '0 6px', fontWeight: 600, whiteSpace: 'nowrap' },
  empty: { color: tk.muted, fontSize: text.sm.fontSize, margin: 0 },
  loading: { color: tk.mutedSoft, fontSize: text.sm.fontSize, margin: 0 },
  err: { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: `${space.sm}px ${space.lg}px`, fontSize: text.md.fontSize, marginTop: space.md },
  hint: { color: tk.muted, fontSize: text.sm.fontSize, margin: `${space.xs}px 0 0` },
  form: { display: 'flex', flexDirection: 'column', gap: space.lg, marginTop: space.lg },
  pre: { background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, padding: space.lg, fontSize: text.xs.fontSize, color: tk.textDim, whiteSpace: 'pre-wrap', margin: `${space.md}px 0 0` },
  code: { background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: 4, padding: '1px 5px', fontSize: text.xs.fontSize, color: tk.accent },
  tokenBox: { background: tk.bg, border: '1px solid var(--line-strong)', borderRadius: tk.r.sm, padding: space.md, fontFamily: 'monospace', fontSize: text.sm.fontSize, color: tk.accent, wordBreak: 'break-all', margin: `${space.md}px 0` },
}

export function Modal({ onClose, maxWidth = 480, children }: { onClose: () => void; maxWidth?: number; children: ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: space.xl }} onClick={onClose}>
      <div role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}
        style={{ background: tk.surfaceHigh, border: '1px solid var(--line-strong)', borderRadius: tk.r.lg, padding: space.xl, width: '100%', maxWidth, display: 'flex', flexDirection: 'column', gap: space.md }}>
        {children}
      </div>
    </div>
  )
}

export function ModalTitle({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <h2 style={{ fontSize: text.lg.fontSize, lineHeight: text.lg.lineHeight, fontWeight: 700, margin: 0, color: tk.text }}>{children}</h2>
      {onClose && <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: tk.muted, fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
    </div>
  )
}

export function FormLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: space.xs, fontSize: text.sm.fontSize, fontWeight: 600, color: tk.textDim, ...style }}>{children}</label>
}
