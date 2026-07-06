'use client'
// MCA-86 — theme mode controller (system | light | dark, no packages).
// `data-theme` on <html> is set pre-paint by the inline script in layout.tsx
// (SSR default: dark). This provider keeps it in sync with the user's choice
// (localStorage '7ei-theme') and, in system mode, with prefers-color-scheme.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { themeSurface } from './dashboard/tokens'

export type ThemeMode = 'system' | 'light' | 'dark'
// NOTE: the pre-paint init script lives in app/layout.tsx (server module) and
// must stay in sync with this key and the resolve logic below.
const THEME_STORAGE_KEY = '7ei-theme'

const resolve = (mode: ThemeMode): 'light' | 'dark' =>
  mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode

const Ctx = createContext<{ mode: ThemeMode; setMode: (m: ThemeMode) => void }>({ mode: 'system', setMode: () => {} })
export const useTheme = () => useContext(Ctx)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system')

  // Read the persisted mode after mount (SSR-safe: server and first client
  // render both use 'system'; the inline script already painted correctly).
  useEffect(() => {
    try {
      const m = localStorage.getItem(THEME_STORAGE_KEY)
      if (m === 'light' || m === 'dark' || m === 'system') setModeState(m as ThemeMode)
    } catch {}
  }, [])

  useEffect(() => {
    // Keep data-theme and the browser theme-color meta in sync with the resolved
    // theme — mirrors the pre-paint script in layout.tsx (T3).
    const apply = () => {
      const t = resolve(mode)
      document.documentElement.setAttribute('data-theme', t)
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeSurface(t))
    }
    apply()
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [mode])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    try { localStorage.setItem(THEME_STORAGE_KEY, m) } catch {}
  }, [])

  return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>
}

// Compact three-state toggle for the dashboard header area. Text labels (not
// color) carry the selected state — colorblind-safe by construction.
const seg: CSSProperties = {
  background: 'transparent', border: 'none', borderRadius: 6, padding: '2px 7px',
  fontSize: 11, lineHeight: '14px', fontWeight: 600, cursor: 'pointer', color: 'var(--muted)',
}
const OPTIONS: { m: ThemeMode; label: string; title: string }[] = [
  { m: 'system', label: 'Auto', title: 'Follow system theme' },
  { m: 'light', label: '☀', title: 'Light theme' },
  { m: 'dark', label: '☾', title: 'Dark theme' },
]

export function ThemeToggle({ style }: { style?: CSSProperties }) {
  const { mode, setMode } = useTheme()
  return (
    <div role="group" aria-label="Theme"
      style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--s2)', border: '1px solid var(--line)', borderRadius: 8, flexShrink: 0, ...style }}>
      {OPTIONS.map(o => (
        <button key={o.m} title={o.title} aria-label={o.title} aria-pressed={mode === o.m}
          onClick={() => setMode(o.m)}
          style={{ ...seg, ...(mode === o.m ? { background: 'var(--s1)', color: 'var(--text)', border: '1px solid var(--line-strong)', padding: '1px 6px' } : {}) }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
