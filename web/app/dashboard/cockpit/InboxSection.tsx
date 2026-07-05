'use client'
// MCA-80 — cockpit inbox: pending approvals (approve/reject) + attention items
// (dismiss). Renders nothing when empty; optimistic mutations live in the root.
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel } from '../ui'
import { EXT_PURPLE, KIND_C, KIND_LABEL, sx, type Approval, type InboxItem } from './shared'

export default function InboxSection({ inbox, approvals, onDismiss, onDecide }: {
  inbox: InboxItem[]
  approvals: Approval[]
  onDismiss: (taskId: string) => void
  onDecide: (id: string, decision: 'approved' | 'rejected') => void
}) {
  if (inbox.length + approvals.length === 0) return null
  return (
    <div>
      <SectionLabel>Inbox · {inbox.length + approvals.length}</SectionLabel>
      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {approvals.map(a => (
          <div key={a.id} style={sx.row}>
            <span style={{ ...sx.tag, background: '#1a0f2a', color: EXT_PURPLE }}>Approval · {a.type}</span>
            <div style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{a.summary}</div>
            <Button style={{ color: tk.green }} onClick={() => onDecide(a.id, 'approved')}>Approve</Button>
            <Button style={{ color: tk.red }} onClick={() => onDecide(a.id, 'rejected')}>Reject</Button>
          </div>
        ))}
        {inbox.map(i => (
          <div key={i.taskId} style={sx.row}>
            <span style={{ ...sx.tag, background: (KIND_C[i.kind] ?? KIND_C.attention).bg, color: (KIND_C[i.kind] ?? KIND_C.attention).fg }}>{KIND_LABEL[i.kind] ?? i.kind}</span>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 600 }}>{i.title}</span>
              <span style={{ fontSize: text.xs.fontSize, color: tk.muted, marginLeft: space.md }}>{i.agentEmoji} {i.agentName}</span>
            </div>
            <Button style={{ color: tk.accent }} onClick={() => onDismiss(i.taskId)}>Dismiss</Button>
          </div>
        ))}
      </Card>
    </div>
  )
}
