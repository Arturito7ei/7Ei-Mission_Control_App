'use client'
// MCA-86 T2 — command palette shell (⌘K / Ctrl-K). Glass chrome, keyboard-first,
// colorblind-safe (selection carries a fill + label, never color alone). This is
// deliberately a *shell*: it takes a flat, grouped Command[] and runs the picked
// one. Epic V feeds it richer commands (jump to task, agent, approval…) by
// concatenating onto the list the parent passes — no change needed here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { tk, text, space } from './tokens'

export type Command = {
  id: string
  label: string
  icon?: string
  hint?: string        // right-aligned muted hint (e.g. shortcut, section)
  group?: string       // section header; commands keep the order given
  keywords?: string    // extra match text not shown in the label
  run: () => void
}

export function CommandPalette({ commands, open, onOpenChange }: {
  commands: Command[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  // Global ⌘K / Ctrl-K toggles the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  // Reset query + selection each time it opens; focus the input.
  useEffect(() => {
    if (!open) return
    setQ(''); setSel(0)
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter(c =>
      `${c.label} ${c.group ?? ''} ${c.keywords ?? ''}`.toLowerCase().includes(needle))
  }, [q, commands])

  // Keep selection in range as the filtered list shrinks/grows.
  useEffect(() => { setSel(s => Math.min(s, Math.max(0, filtered.length - 1))) }, [filtered.length])

  const runAt = useCallback((i: number) => {
    const cmd = filtered[i]
    if (!cmd) return
    close()
    cmd.run()
  }, [filtered, close])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(sel) }
  }

  // Scroll the selected row into view on keyboard nav.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel, open])

  if (!open) return null

  // Render with lightweight group headers: a header is emitted when a row's
  // group differs from the previous row's (order is preserved from `commands`).
  let lastGroup: string | undefined
  return (
    <div style={s.scrim} onClick={close}>
      <div className="mc-glass" role="dialog" aria-modal="true" aria-label="Command palette"
        onClick={e => e.stopPropagation()} onKeyDown={onKeyDown} style={s.panel}>
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search commands…"
          aria-label="Search commands"
          role="combobox" aria-expanded aria-controls="cmdk-list"
          aria-activedescendant={filtered[sel] ? `cmdk-opt-${filtered[sel].id}` : undefined}
          style={s.input}
        />
        <div id="cmdk-list" ref={listRef} role="listbox" aria-label="Commands" style={s.list}>
          {filtered.length === 0 && <div style={s.empty}>No matching commands.</div>}
          {filtered.map((c, i) => {
            const header = c.group && c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            const active = i === sel
            return (
              <div key={c.id}>
                {header && <div style={s.group}>{header}</div>}
                <div
                  id={`cmdk-opt-${c.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={active}
                  onMouseMove={() => setSel(i)}
                  onClick={() => runAt(i)}
                  style={{ ...s.row, ...(active ? s.rowActive : null) }}
                >
                  {c.icon && <span aria-hidden style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>{c.icon}</span>}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                  {c.hint && <span style={s.hint}>{c.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div style={s.footer}>
          <span><kbd style={s.kbd}>↑</kbd><kbd style={s.kbd}>↓</kbd> navigate</span>
          <span><kbd style={s.kbd}>↵</kbd> select</span>
          <span><kbd style={s.kbd}>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, CSSProperties> = {
  // Top-anchored so it feels like a launcher; scrim closes on click-out.
  scrim: { position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 60, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '12vh 16px 16px' },
  panel: { width: '100%', maxWidth: 560, maxHeight: '64vh', border: '1px solid var(--glass-line)', borderRadius: tk.r.lg, boxShadow: 'var(--shadow-modal)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  input: { height: 44, boxSizing: 'border-box', background: 'transparent', border: 'none', borderBottom: '1px solid var(--glass-line)', padding: `0 ${space.xl}px`, color: tk.text, fontSize: text.lg.fontSize, outline: 'none', width: '100%' },
  list: { overflow: 'auto', padding: space.xs, flex: 1 },
  group: { fontSize: text.xs.fontSize, fontWeight: 700, color: tk.muted, textTransform: 'uppercase', letterSpacing: 0.6, padding: `${space.md}px ${space.md}px ${space.xs}px` },
  row: { display: 'flex', alignItems: 'center', gap: space.md, padding: `0 ${space.md}px`, height: 34, borderRadius: tk.r.sm, cursor: 'pointer', fontSize: text.md.fontSize, color: tk.textDim },
  // Selection = accent-tinted fill + accent text (label-backed, not color-only).
  rowActive: { background: 'var(--accent-dim)', color: tk.text, boxShadow: 'inset 0 0 0 1px var(--accent-line)' },
  hint: { fontSize: text.xs.fontSize, color: tk.muted, flexShrink: 0 },
  empty: { padding: space.lg, fontSize: text.sm.fontSize, color: tk.muted },
  footer: { display: 'flex', gap: space.lg, padding: `${space.sm}px ${space.lg}px`, borderTop: '1px solid var(--glass-line)', fontSize: text.xs.fontSize, color: tk.muted, flexShrink: 0 },
  kbd: { display: 'inline-block', minWidth: 16, textAlign: 'center', background: tk.surfaceHigh, border: '1px solid var(--line-strong)', borderRadius: 4, padding: '0 4px', marginRight: 3, fontSize: 10, lineHeight: '15px', color: tk.textDim, fontFamily: 'inherit' },
}
