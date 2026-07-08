'use client'
// Epic P / P0a — "coming soon" view for Paperclip areas we've surfaced in the
// nav but haven't built yet. Honest by design: says what the area is, why it's
// not here, and points at the Epic-P gap plan. Tokens only, colorblind-safe.
import { findNavItem, GAP_DOC } from '@/lib/navModel'

export default function PlaceholderView({ id }: { id: string }) {
  const item = findNavItem(id)
  if (!item) return null
  return (
    <div style={s.page}>
      <div style={s.card}>
        <span style={{ fontSize: 44 }} aria-hidden>{item.icon}</span>
        <div style={s.badge}>Coming soon</div>
        <h1 style={s.h1}>{item.label}</h1>
        <p style={s.map}>Paperclip area: <strong style={{ color: 'var(--text)' }}>{item.paperclip}</strong></p>
        {item.note && <p style={s.note}>{item.note}</p>}
        <p style={s.gap}>
          Tracked under <strong style={{ color: 'var(--text)' }}>Epic P</strong> — see the gap plan
          {' '}<code style={s.code}>{GAP_DOC}</code> and <code style={s.code}>docs/IA-paperclip-mapping.md</code>.
        </p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { padding: 28, maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
  card: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 16, padding: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 },
  badge: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-2)', background: 'var(--s2)', border: '1px solid var(--line-strong)', borderRadius: 999, padding: '3px 12px' },
  h1: { fontSize: 26, fontWeight: 800, margin: '4px 0 0', letterSpacing: -0.4 },
  map: { fontSize: 14, color: 'var(--muted)', margin: 0 },
  note: { fontSize: 14, color: 'var(--text-2)', margin: '4px 0 0', lineHeight: 1.7, maxWidth: 520 },
  gap: { fontSize: 13, color: 'var(--muted)', margin: '8px 0 0', lineHeight: 1.7 },
  code: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, background: 'var(--s2)', border: '1px solid var(--line)', borderRadius: 4, padding: '1px 6px', color: 'var(--accent)' },
}
