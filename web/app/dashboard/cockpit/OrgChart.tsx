'use client'
// MCA-80 — recursive reporting tree (read-only).
import { tk, text, space } from '../tokens'
import { Card, SectionLabel } from '../ui'
import { RUNTIME_BADGE, sx, type OrgNode } from './shared'

function NodeRow({ node, depth }: { node: OrgNode; depth: number }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: `${space.xs}px 0`, paddingLeft: depth * 20 }}>
        {depth > 0 && <span aria-hidden style={{ color: '#444' }}>└─</span>}
        <span style={{ fontSize: 16 }}>{node.avatarEmoji || '🤖'}</span>
        <span style={{ fontWeight: 600, fontSize: text.md.fontSize }}>{node.name}</span>
        <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{node.title || node.role}</span>
        {node.runtime && <span style={sx.badge}>{RUNTIME_BADGE[node.runtime] ?? '⚙️'} {node.runtime}</span>}
      </div>
      {node.children.map(c => <NodeRow key={c.id} node={c} depth={depth + 1} />)}
    </>
  )
}

export default function OrgChart({ chart }: { chart: OrgNode[] | null }) {
  return (
    <div>
      <SectionLabel>Org chart</SectionLabel>
      <Card>
        {(chart ?? []).map(n => <NodeRow key={n.id} node={n} depth={0} />)}
        {chart && chart.length === 0 && <p style={sx.empty}>No agents yet.</p>}
        {!chart && <p style={sx.loading}>Loading…</p>}
      </Card>
    </div>
  )
}
