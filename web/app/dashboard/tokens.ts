// MCA-86 (Epic T1) — tokens v2: light/dark theme map per docs/DESIGN_SYSTEM.md v2.
// Raw color values live ONLY in `themes` below; everything else (the compat
// `tk` object, panels, primitives) consumes `var(--*)` strings so the whole
// dashboard follows `<html data-theme>`. Density/type/space scales (MCA-79)
// are unchanged. Colorblind-safe status colors live in ./status.ts.
import type { CSSProperties } from 'react'

export type ThemeName = 'light' | 'dark'

export const themes: Record<ThemeName, Record<string, string>> = {
  light: {
    // — DESIGN_SYSTEM v2 semantic token table —
    '--s0': '#f5f5f3',                       // page
    '--s1': '#ffffff',                       // card
    '--s2': '#ebebeb',                       // raised
    '--glass': 'rgba(255,255,255,.72)',
    '--glass-line': 'rgba(0,0,0,.07)',
    '--line': '#e5e5e3',
    '--line-strong': '#d5d5d3',
    '--text': '#070707',
    '--text-2': '#555555',                   // silver tier
    '--muted': '#6b6b6b',                    // T3 a11y: was #8a8a88 (3.5:1) → 5.3:1 on card
    '--accent': '#700077',                   // Zeus — CTA/active on light
    '--accent-2': '#893BFF',
    '--brand-red': '#D4001A',
    '--ok': '#1f7a1f', '--ok-bg': '#eef4e8',
    '--warn': '#6b6100', '--warn-bg': '#fff9c2',
    '--info': '#3500ff', '--info-bg': '#eceafd',
    '--danger-text': '#D4001A',
    '--purple-1': '#893BFF',                 // Aztec — agent identity, mode-stable
    '--purple-2': '#700077',                 // Zeus
    // — derived tints/support (kept here so no component carries raw hex) —
    '--accent-contrast': '#ffffff',          // text on an accent fill
    '--accent-hover': '#893BFF',
    '--accent-dim': 'rgba(137,59,255,.07)',
    '--accent-line': 'rgba(137,59,255,.2)',  // accent border
    '--accent-glow': 'rgba(137,59,255,.10)',
    '--danger-bg': 'rgba(212,0,26,.06)',
    '--danger-line': 'rgba(212,0,26,.24)',   // error border
    '--skeleton': '#e7e7e4',
    '--text-3': '#cccccc',                   // disabled
    '--scrim': 'rgba(7,7,7,.35)',
    // T2 glass chrome — elevation for floating chrome (drawer/modal/palette).
    '--shadow-modal': '0 16px 48px rgba(7,7,7,.16)',
    '--shadow-drawer': '-12px 0 40px rgba(7,7,7,.14)',
  },
  dark: {
    '--s0': '#070707',
    '--s1': '#0f0f0f',
    '--s2': '#161616',
    '--glass': 'rgba(15,15,15,.72)',
    '--glass-line': 'rgba(199,199,199,.08)',
    '--line': '#1e1e1e',
    '--line-strong': '#2a2a2a',
    '--text': '#ffffff',
    '--text-2': '#c7c7c7',
    '--muted': '#7e7e7e',                    // T3 a11y: was #555555 (2.6:1) → 4.7:1 on card
    '--accent': '#893BFF',                   // Aztec — CTA/active on dark
    '--accent-2': '#700077',
    '--brand-red': '#D4001A',
    '--ok': '#33c333', '--ok-bg': '#0e2a0e',
    '--warn': '#c9b800', '--warn-bg': '#33300a',
    '--info': '#7b6dff', '--info-bg': '#14104a',
    '--danger-text': '#ff3b52',              // red text lifted for dark
    '--purple-1': '#893BFF',
    '--purple-2': '#700077',
    '--accent-contrast': '#ffffff',
    '--accent-hover': '#9d5aff',
    '--accent-dim': 'rgba(137,59,255,.10)',
    '--accent-line': 'rgba(137,59,255,.3)',
    '--accent-glow': 'rgba(137,59,255,.18)',
    '--danger-bg': 'rgba(212,0,26,.09)',
    '--danger-line': 'rgba(212,0,26,.35)',
    '--skeleton': '#1d1d1d',
    '--text-3': '#333333',
    '--scrim': 'rgba(0,0,0,.6)',
    '--shadow-modal': '0 16px 48px rgba(0,0,0,.6)',
    '--shadow-drawer': '-12px 0 40px rgba(0,0,0,.5)',
  },
}

// Page-surface hex for a theme — the PWA/browser `theme-color` (address bar,
// standalone title bar) tracks --s0 so the chrome matches the app background in
// both modes. Single source of truth: the theme map above (no new raw hex).
export const themeSurface = (t: ThemeName): string => themes[t]['--s0']

// CSS emitted into an inline <style> by app/layout.tsx. Dark doubles as the
// `:root` default so SSR / no-JS paints the current dark look before hydration.
export function themeCss(): string {
  const block = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';')
  return `:root,[data-theme="dark"]{${block(themes.dark)}}\n[data-theme="light"]{${block(themes.light)}}`
}

// Compatibility layer — same keys as tk v1 (MCA-70), values are now var()
// strings so every existing `tk.*` consumer themes automatically.
// Intentional visual change: `accent` was orange #FFB800, is now purple
// (Zeus on light / Aztec on dark) per DESIGN_SYSTEM v2. `red` maps to
// --danger-text (error/destructive only — never a primary CTA fill).
export const tk = {
  // surfaces
  bg: 'var(--s0)', surface: 'var(--s1)', surfaceHigh: 'var(--s2)',
  line: 'var(--line)', lineSoft: 'var(--line)',
  skeleton: 'var(--skeleton)', // MCA-81 — loading placeholder blocks
  // text
  text: 'var(--text)', textDim: 'var(--text-2)', muted: 'var(--muted)', mutedSoft: 'var(--muted)',
  // accent + status
  accent: 'var(--accent)', blue: 'var(--info)', green: 'var(--ok)', amber: 'var(--warn)', red: 'var(--danger-text)',
  accentContrast: 'var(--accent-contrast)', // v2 — text on accent fills (purple needs white, not black)
  // scale (unchanged)
  r: { sm: 8, md: 10, lg: 12, pill: 999 },
  sp: { xs: 6, sm: 8, md: 12, lg: 16, xl: 20 },
} as const

// MCA-79 — max-density utilitarian scales (additive; nothing above is renamed).
// Rows target ~28px: cellY 6 + 16px text line + cellY 6. Controls match rows.
export const density = {
  row: 28,             // table/list row height (border-box)
  cellX: 8, cellY: 6,  // cell padding
  ctrl: 28,            // button/input height
} as const

// Type ramp — small but legible on both surfaces (pairs with tk.text*).
export const text = {
  xs: { fontSize: 11, lineHeight: '14px' },
  sm: { fontSize: 12, lineHeight: '16px' },
  md: { fontSize: 13, lineHeight: '18px' },
  lg: { fontSize: 14, lineHeight: '20px' },
} as const

// Spacing steps (px) — prefer these over ad-hoc margins in dense layouts.
export const space = { xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 } as const

// Legacy status map — re-pointed at the v2 status table (active = purple, not
// green; red only for failure states). Prefer statusColor()/statusIcon() from
// ./status.ts for new code — and always pair color with an icon or label.
export const STATUS_COLOR: Record<string, string> = {
  done: 'var(--ok)', failed: 'var(--danger-text)', in_progress: 'var(--accent)', assigned: 'var(--muted)',
  blocked: 'var(--danger-text)', pending: 'var(--muted)',
  idle: 'var(--muted)', active: 'var(--accent)', paused: 'var(--warn)', terminated: 'var(--danger-text)',
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
  pill: { fontSize: 11, fontWeight: 700, border: `1px solid var(--line-strong)`, borderRadius: tk.r.pill, padding: '2px 9px' },
  input: { background: tk.bg, border: '1px solid var(--line-strong)', borderRadius: tk.r.md, padding: '9px 11px', color: tk.text, fontSize: 13 },
  ghost: { background: tk.surfaceHigh, border: '1px solid var(--line-strong)', color: tk.accent, padding: '9px 14px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btn: { background: tk.surfaceHigh, border: '1px solid var(--line-strong)', color: tk.textDim, padding: '7px 12px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  // Primary CTA = accent (purple) fill; destructive = red OUTLINE, never a fill (colorblind rule 4).
  btnPrimary: { background: tk.accent, border: `1px solid ${tk.accent}`, color: tk.accentContrast, padding: '8px 14px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 },
  btnDanger: { background: 'transparent', border: '1px solid var(--danger-line)', color: tk.red, padding: '7px 12px', borderRadius: tk.r.md, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  err: { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: '9px 12px', fontSize: 13 },
  ok: { background: 'var(--ok-bg)', border: '1px solid var(--ok)', color: tk.green, borderRadius: tk.r.md, padding: '9px 12px', fontSize: 13 },
}
