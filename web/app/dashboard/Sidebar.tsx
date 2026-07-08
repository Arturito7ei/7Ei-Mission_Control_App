'use client'
// Epic P / P0a — Paperclip-style folded navigation rail.
// Grouped + collapsible (Overview · Workspace · Operate · Delivery · Company ·
// General), the whole rail folds to icons, and both states persist per browser.
// Structure is data-driven from lib/navModel (pure + unit-tested); this file is
// only presentation. Colorblind-safe: active = accent + bold + left indicator
// bar (never color alone); placeholders carry a "soon" text chip.
import { useEffect, useState } from 'react'
import {
  NAV_GROUPS, parseCollapsed, serializeCollapsed, toggleCollapsed,
  type NavGroupId, type NavItem,
} from '@/lib/navModel'
import { ThemeToggle } from '../theme'
import Mark from './Mark'

const COLLAPSED_KEY = 'mc.nav.collapsed'
const RAIL_KEY = 'mc.nav.railFolded'

export default function Sidebar({
  orgName, selected, onSelect, onOpenPalette, unread,
}: {
  orgName: string
  selected: string
  onSelect: (id: string) => void
  onOpenPalette: () => void
  unread: number
}) {
  // Start from defaults (SSR-safe), hydrate from localStorage after mount so the
  // server and first client paint agree.
  const [collapsed, setCollapsed] = useState<Set<NavGroupId>>(new Set())
  const [folded, setFolded] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(parseCollapsed(localStorage.getItem(COLLAPSED_KEY)))
      setFolded(localStorage.getItem(RAIL_KEY) === '1')
    } catch {}
  }, [])

  const toggleGroup = (id: NavGroupId) => {
    setCollapsed(prev => {
      const next = toggleCollapsed(prev, id)
      try { localStorage.setItem(COLLAPSED_KEY, serializeCollapsed(next)) } catch {}
      return next
    })
  }
  const toggleRail = () => {
    setFolded(prev => {
      const next = !prev
      try { localStorage.setItem(RAIL_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }

  return (
    <aside className="mc-sidebar mc-glass" style={{ ...s.sidebar, width: folded ? 64 : 220 }}>
      {/* Brand + theme toggle */}
      <div style={s.brand}>
        <Mark size={22} />
        {!folded && <><span style={s.brandName}>7Ei</span><span style={{ flex: 1 }} /><ThemeToggle /></>}
      </div>
      {!folded && <div style={s.orgLabel}>{orgName}</div>}

      {/* Command palette launcher (⌘K opens from anywhere) */}
      <button className="mc-search" style={{ ...s.searchBtn, justifyContent: folded ? 'center' : 'flex-start' }}
        onClick={onOpenPalette} aria-label="Open command palette" aria-keyshortcuts="Meta+K Control+K"
        title={folded ? 'Search (⌘K)' : undefined}>
        <span aria-hidden>🔍</span>
        {!folded && <><span style={{ flex: 1, textAlign: 'left' }}>Search…</span><kbd style={s.kbdHint} aria-hidden>⌘K</kbd></>}
      </button>

      <nav className="mc-nav" style={s.nav}>
        {NAV_GROUPS.map(g => {
          const isCollapsed = collapsed.has(g.id)
          return (
            <div key={g.id} style={s.group}>
              {/* Group header — folds the rail's groups. Hidden when the whole
                  rail is icon-folded (a thin separator stands in). */}
              {folded ? (
                <div style={s.foldDivider} aria-hidden />
              ) : (
                <button style={s.groupHeader} onClick={() => toggleGroup(g.id)}
                  aria-expanded={!isCollapsed} aria-controls={`navgrp-${g.id}`}>
                  <span style={{ ...s.caret, transform: isCollapsed ? 'rotate(-90deg)' : 'none' }} aria-hidden>▾</span>
                  <span>{g.label}</span>
                </button>
              )}
              {(folded || !isCollapsed) && (
                <div id={`navgrp-${g.id}`} style={s.groupItems}>
                  {g.items.map(item => (
                    <NavButton key={item.id} item={item} folded={folded}
                      active={selected === item.id} onSelect={onSelect} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Fold/expand the whole rail */}
      <button style={s.railToggle} onClick={toggleRail}
        aria-label={folded ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={folded} title={folded ? 'Expand' : 'Collapse'}>
        <span aria-hidden>{folded ? '»' : '«'}</span>{!folded && <span>Collapse</span>}
      </button>

      {!folded && unread > 0 && (
        <div style={s.notifBanner}><span aria-hidden>🔔</span><span style={{ flex: 1, fontSize: 13 }}>{unread} task{unread > 1 ? 's' : ''} done</span></div>
      )}
    </aside>
  )
}

function NavButton({ item, folded, active, onSelect }: {
  item: NavItem; folded: boolean; active: boolean; onSelect: (id: string) => void
}) {
  const placeholder = item.kind === 'placeholder'
  const title = folded
    ? `${item.label}${placeholder ? ' — coming soon' : ''}`
    : (placeholder ? item.note : `Paperclip: ${item.paperclip}`)
  return (
    <button onClick={() => onSelect(item.id)} title={title}
      aria-current={active ? 'page' : undefined}
      style={{
        ...s.navBtn,
        ...(folded ? s.navBtnFolded : {}),
        ...(active ? s.navActive : {}),
        ...(placeholder && !active ? s.navPlaceholder : {}),
      }}>
      {/* Active indicator bar — carries the "selected" signal without relying on
          color alone (colorblind rule). */}
      {active && !folded && <span aria-hidden style={s.activeBar} />}
      <span aria-hidden>{item.icon}</span>
      {!folded && <span style={{ flex: 1 }}>{item.label}</span>}
      {!folded && placeholder && <span style={s.soon}>soon</span>}
    </button>
  )
}

const s: Record<string, React.CSSProperties> = {
  sidebar: { borderRight: '1px solid var(--glass-line)', display: 'flex', flexDirection: 'column', padding: '16px 12px', gap: 4, overflow: 'auto', transition: 'width .16s ease', flexShrink: 0 },
  brand: { display: 'flex', alignItems: 'center', gap: 8, padding: 8, color: 'var(--text)', marginBottom: 4, flexShrink: 0, minHeight: 22 },
  brandName: { fontSize: 15, fontWeight: 700, letterSpacing: 0.2 },
  orgLabel: { fontSize: 14, fontWeight: 700, color: 'var(--text)', padding: '8px 4px', borderBottom: '1px solid var(--line)', marginBottom: 8 },
  searchBtn: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'var(--s2)', border: '1px solid var(--line-strong)', color: 'var(--muted)', borderRadius: 8, padding: '7px 10px', fontSize: 13, cursor: 'pointer', marginBottom: 8, flexShrink: 0 },
  kbdHint: { fontSize: 10, fontWeight: 600, color: 'var(--text-2)', background: 'var(--s1)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: '1px 5px', fontFamily: 'inherit' },
  nav: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 },
  group: { display: 'flex', flexDirection: 'column' },
  groupHeader: { display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: 'var(--muted)', padding: '8px 8px 4px', cursor: 'pointer', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, width: '100%', textAlign: 'left' },
  caret: { fontSize: 9, transition: 'transform .12s ease', display: 'inline-block', width: 10 },
  groupItems: { display: 'flex', flexDirection: 'column', gap: 2 },
  foldDivider: { height: 1, background: 'var(--line)', margin: '6px 8px' },
  navBtn: { position: 'relative', display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', color: 'var(--muted)', padding: '9px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500, width: '100%', textAlign: 'left' },
  navBtnFolded: { justifyContent: 'center', padding: '9px 0' },
  navActive: { background: 'var(--s2)', color: 'var(--accent)', fontWeight: 700 },
  navPlaceholder: { color: 'var(--text-2)' },
  activeBar: { position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, background: 'var(--accent)' },
  soon: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-2)', background: 'var(--s2)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: '1px 5px' },
  railToggle: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', background: 'transparent', border: '1px solid var(--line)', color: 'var(--muted)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600, marginTop: 4, flexShrink: 0 },
  notifBanner: { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--s2)', borderRadius: 8, padding: '10px 12px', marginTop: 8, fontSize: 13, color: 'var(--text)', border: '1px solid var(--line-strong)', flexShrink: 0 },
}
