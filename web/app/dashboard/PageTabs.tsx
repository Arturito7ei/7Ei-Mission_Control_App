'use client'
// P1 — the tab bar for a page that hosts other surfaces as tabs (Costs | Budgets,
// Connectors | Plugins, Inbox | Comms, Settings | Adapters | Secrets). The tabs
// come from lib/navModel (`navPageTabs`); this file is only presentation.
// Colorblind-safe: the active tab carries accent + bold + a filled background,
// and aria-selected states it outright.
import type { PageTab } from '@/lib/navModel'

export default function PageTabs({ tabs, active, onSelect }: {
  tabs: PageTab[]
  active: string
  onSelect: (id: string) => void
}) {
  if (tabs.length < 2) return null
  return (
    <div style={s.bar}>
      <div role="tablist" aria-label="Page sections" style={s.list}>
        {tabs.map(t => {
          const on = t.id === active
          return (
            <button key={t.id} role="tab" aria-selected={on} onClick={() => onSelect(t.id)}
              style={{
                ...s.tab,
                background: on ? 'var(--accent-dim)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent-line)' : 'var(--line-strong)'}`,
                color: on ? 'var(--accent)' : 'var(--muted)',
                fontWeight: on ? 700 : 600,
              }}>{t.label}</button>
          )
        })}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  bar: { padding: '20px 28px 0', maxWidth: 1200, margin: '0 auto' },
  list: { display: 'flex', gap: 6, borderBottom: '1px solid var(--line)', paddingBottom: 12 },
  tab: { borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 12.5 },
}
