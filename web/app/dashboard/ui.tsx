'use client'
// MCA-79 — tiny shared primitives for the dashboard panels. Style-object based,
// token-fed, max-density utilitarian. Not a component library: same dark
// aesthetic as before, just consistent and tighter. Keep additions minimal.
import { createContext, useContext } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { tk, density, text, space } from './tokens'

// ——— Button ———————————————————————————————————————————————————————————————

export type ButtonVariant = 'default' | 'primary' | 'danger'

const BTN_BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: space.sm,
  height: density.ctrl, padding: `0 ${space.lg}px`, borderRadius: tk.r.md, boxSizing: 'border-box',
  fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
}
const BTN_VARIANT: Record<ButtonVariant, CSSProperties> = {
  default: { background: '#1a1a1a', border: '1px solid #333', color: tk.textDim },
  primary: { background: tk.accent, border: `1px solid ${tk.accent}`, color: '#000', fontWeight: 700 },
  danger: { background: '#1a1010', border: '1px solid #5a2a2a', color: tk.red },
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
      style={{ height: density.ctrl, boxSizing: 'border-box', background: '#000', border: '1px solid #333', borderRadius: tk.r.md, padding: `0 ${density.cellX}px`, color: tk.text, fontSize: text.md.fontSize, ...style }} />
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

// ——— SectionLabel —————————————————————————————————————————————————————————

export function SectionLabel({ style, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 {...rest} style={{ fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, fontWeight: 700, color: tk.muted, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 6px', ...style }} />
}
