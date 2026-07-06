'use client'
// MCA-79 — tiny shared primitives for the dashboard panels. Style-object based,
// token-fed, max-density utilitarian. Not a component library: same dark
// aesthetic as before, just consistent and tighter. Keep additions minimal.
import { createContext, useContext } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { tk, density, text, space } from './tokens'

// ——— Button ———————————————————————————————————————————————————————————————

export type ButtonVariant = 'default' | 'primary' | 'danger'

const BTN_BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: space.sm,
  height: density.ctrl, padding: `0 ${space.lg}px`, borderRadius: tk.r.md, boxSizing: 'border-box',
  fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
}
// MCA-86: primary = accent (purple) fill; danger = red OUTLINE + red text —
// destructive is never a red fill (DESIGN_SYSTEM v2 colorblind rule 4).
const BTN_VARIANT: Record<ButtonVariant, CSSProperties> = {
  default: { background: tk.surfaceHigh, border: '1px solid var(--line-strong)', color: tk.textDim },
  primary: { background: tk.accent, border: `1px solid ${tk.accent}`, color: tk.accentContrast, fontWeight: 700 },
  danger: { background: 'transparent', border: '1px solid var(--danger-line)', color: tk.red },
}

export function Button({ variant = 'default', disabled, style, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button {...rest} disabled={disabled}
      style={{ ...BTN_BASE, ...BTN_VARIANT[variant], ...(disabled ? { opacity: 0.55, cursor: 'default' } : {}), ...style }} />
  )
}

// ——— Card —————————————————————————————————————————————————————————————————

export function Card({ style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} style={{ background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, padding: space.lg, ...style }} />
}

// ——— Pill —————————————————————————————————————————————————————————————————
// Semantic status chip: label text + color, never color alone.

export type PillTone = 'ok' | 'fail' | 'warn' | 'muted'
const PILL_COLOR: Record<PillTone, string> = { ok: tk.green, fail: tk.red, warn: tk.amber, muted: tk.muted }

export function Pill({ tone = 'muted', style, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: PillTone }) {
  const c = PILL_COLOR[tone]
  return (
    <span {...rest} style={{ fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700, color: c, border: `1px solid ${c}`, borderRadius: tk.r.pill, padding: '1px 8px', whiteSpace: 'nowrap', ...style }} />
  )
}

// ——— TextInput ————————————————————————————————————————————————————————————

export function TextInput({ style, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...rest}
      style={{ height: density.ctrl, boxSizing: 'border-box', background: tk.bg, border: '1px solid var(--line-strong)', borderRadius: tk.r.md, padding: `0 ${density.cellX}px`, color: tk.text, fontSize: text.md.fontSize, ...style }} />
  )
}

// ——— Select ———————————————————————————————————————————————————————————————
// Same box as TextInput; native element, no custom dropdown.

export function Select({ style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest}
      style={{ height: density.ctrl, boxSizing: 'border-box', background: tk.bg, border: '1px solid var(--line-strong)', borderRadius: tk.r.md, padding: `0 ${density.cellX}px`, color: tk.text, fontSize: text.md.fontSize, fontFamily: 'inherit', ...style }} />
  )
}

// ——— TextArea ——————————————————————————————————————————————————————————————

export function TextArea({ style, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...rest}
      style={{ boxSizing: 'border-box', background: tk.bg, border: '1px solid var(--line-strong)', borderRadius: tk.r.md, padding: `${density.cellY}px ${density.cellX}px`, color: tk.text, fontSize: text.md.fontSize, fontFamily: 'inherit', resize: 'vertical', ...style }} />
  )
}

// ——— IconButton ———————————————————————————————————————————————————————————
// Tiny inline row action (✕ / ▶ / ⏸ / On / Off) — smaller than density.ctrl on
// purpose so dense rows stay 28px.

export function IconButton({ style, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest}
      style={{ background: 'transparent', border: '1px solid var(--line-strong)', color: tk.muted, borderRadius: 6, padding: '1px 6px', fontSize: text.xs.fontSize, lineHeight: 1.4, cursor: 'pointer', ...style }} />
  )
}

// ——— DenseTable ———————————————————————————————————————————————————————————
// Grid-based table (matches the panels' existing thead/trow pattern) that
// enforces the density scale. Column template flows to rows via context so
// callers declare it once.

const TableCols = createContext('1fr')

export function DenseTable({ cols, head, children, style }: { cols: string; head: ReactNode[]; children?: ReactNode; style?: CSSProperties }) {
  return (
    <TableCols.Provider value={cols}>
      <div style={{ border: `1px solid ${tk.line}`, borderRadius: tk.r.md, overflow: 'hidden', ...style }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: space.md, alignItems: 'center', boxSizing: 'border-box', minHeight: density.row, padding: `${density.cellY}px ${density.cellX}px`, background: tk.surfaceHigh, fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, color: tk.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {head.map((h, i) => <span key={i}>{h}</span>)}
        </div>
        {children}
      </div>
    </TableCols.Provider>
  )
}

export function DenseRow({ style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const cols = useContext(TableCols)
  return (
    <div {...rest}
      style={{ display: 'grid', gridTemplateColumns: cols, gap: space.md, alignItems: 'center', boxSizing: 'border-box', minHeight: density.row, padding: `${density.cellY}px ${density.cellX}px`, borderTop: `1px solid ${tk.lineSoft}`, fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, ...style }} />
  )
}

// ——— Skeleton ——————————————————————————————————————————————————————————————
// MCA-81 — static muted block shown while a panel's initial load is in flight.
// Deliberately no shimmer/animation: max-density utilitarian.

export function Skeleton({ w = '100%', h = 14, style }: { w?: number | string; h?: number | string; style?: CSSProperties }) {
  return <div aria-hidden="true" style={{ width: w, height: h, background: tk.skeleton, borderRadius: 4, flexShrink: 0, ...style }} />
}

// ——— SectionLabel —————————————————————————————————————————————————————————

export function SectionLabel({ style, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 {...rest} style={{ fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, fontWeight: 700, color: tk.muted, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 6px', ...style }} />
}
