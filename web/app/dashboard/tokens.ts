// MCA-UI U1 (MCA-70) — shared design tokens + primitives for the dashboard.
// Replaces per-component inline hex with one source of truth. Muted greys are
// bumped to WCAG-AA-safe values on the near-black surfaces (a11y, MCA-73).
import type { CSSProperties } from 'react'

export const tk = {
  // surfaces
  bg: '#0a0a0a', surface: '#0e0e0e', surfaceHigh: '#111', line: '#222', lineSoft: '#1a1a1a',
  // text (contrast-checked on bg)
  text: '#e6e8eb', textDim: '#c9cdd3', muted: '#9aa0a6', mutedSoft: '#8b9096',
  // accent + status
  accent: '#FFB800', blue: '#4aa8ff', green: '#22c55e', amber: '#e0b000', red: '#ff8080',
  // scale
  r: { sm: 8, md: 10, lg: 12, pill: 999 },
  sp: { xs: 6, sm: 8, md: 12, lg: 16, xl: 20 },
} as const

export const STATUS_COLOR: Record<string, string> = {
  done: tk.green, failed: tk.red, in_progress: tk.blue, assigned: tk.amber, blocked: tk.red, pending: tk.muted,
  idle: tk.muted, active: tk.green, paused: tk.amber, terminated: tk.red,
}

// Shared primitives — import these instead of re-declaring per component.
export const ui: Record<string, CSSProperties> = {
  page: { padding: 28, maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: tk.sp.xl },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 12, color: tk.text },
  h2: { fontSize: 13, fontWeight: 700, color: tk.muted, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 6px' },
  sub: { fontSize: 12, color: tk.muted, background: tk.surfaceHigh, border: `1px solid ${tk.line}`, borderRadius: tk.r.pill, padding: '3px 11px', fontWeight: 500 },
  hint: { fontSize: 12, color: tk.mutedSoft, margin: '0 0 10px' },
  card: { background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, padding: tk.sp.lg },
  row: { display: 'flex', gap: 10, alignItems: 'center' },
  muted: { color: tk.muted, fontSize: 12.5 },
  pill: { fontSize: 11, fontWeight: 700, border: `1px solid #2a2a2a`, borderRadius: tk.r.pill, padding: '2px 9px' },
  input: { background: '#000', border: '1px solid #333', borderRadius: tk.r.md, padding: '9px 11px', color: tk.text, fontSize: 13 },
  ghost: { background: '#1a1a1a', border: '1px solid #333', color: tk.accent, padding: '9px 14px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btn: { background: '#1a1a1a', border: '1px solid #333', color: tk.textDim, padding: '7px 12px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  btnPrimary: { background: tk.accent, border: `1px solid ${tk.accent}`, color: '#000', padding: '8px 14px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 },
  btnDanger: { background: '#1a1010', border: '1px solid #5a2a2a', color: tk.red, padding: '7px 12px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  err: { background: '#2a1414', border: '1px solid #5a2a2a', color: tk.red, borderRadius: tk.r.md, padding: '9px 12px', fontSize: 13 },
  ok: { background: '#12210f', border: '1px solid #2a5a2a', color: '#8fe08f', borderRadius: tk.r.md, padding: '9px 12px', fontSize: 13 },
}
