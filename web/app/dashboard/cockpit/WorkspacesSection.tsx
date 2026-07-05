'use client'
// MCA-80 — repo workspaces (worktree + operator branch per task) + dialog.
// Delete is optimistic and owned by the composition root.
import { useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, IconButton, SectionLabel, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, sx, type Getter, type Workspace } from './shared'

function WorkspaceDialog({ orgId, getToken, onClose, onDone }: { orgId: string; getToken: Getter; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', repoUrl: '', baseBranch: 'main', previewUrl: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    if (!f.name.trim()) return
    setBusy(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/workspaces`, { token: await getToken(), method: 'POST', body: JSON.stringify({ name: f.name, repoUrl: f.repoUrl || undefined, baseBranch: f.baseBranch || 'main', previewUrl: f.previewUrl || undefined }) })
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  return (
    <Modal onClose={onClose}>
      <ModalTitle onClose={onClose}>New workspace</ModalTitle>
      <p style={sx.hint}>Runtimes create a git worktree + operator branch per task in this workspace.</p>
      <div style={sx.form}>
        <FormLabel>Name<TextInput autoFocus value={f.name} placeholder="mission-control-app" onChange={e => setF({ ...f, name: e.target.value })} /></FormLabel>
        <FormLabel>Repo URL<TextInput value={f.repoUrl} placeholder="git@github.com:Arturito7ei/…" onChange={e => setF({ ...f, repoUrl: e.target.value })} /></FormLabel>
        <div style={{ display: 'flex', gap: space.md }}>
          <FormLabel style={{ flex: 1 }}>Base branch<TextInput value={f.baseBranch} onChange={e => setF({ ...f, baseBranch: e.target.value })} /></FormLabel>
          <FormLabel style={{ flex: 1 }}>Preview URL<TextInput value={f.previewUrl} placeholder="https://…" onChange={e => setF({ ...f, previewUrl: e.target.value })} /></FormLabel>
        </div>
      </div>
      {err && <div style={sx.err}>⚠ {err}</div>}
      <Button variant="primary" style={{ marginTop: space.md }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Create workspace'}</Button>
    </Modal>
  )
}

export default function WorkspacesSection({ orgId, getToken, workspaces, onDelete, onChanged }: {
  orgId: string; getToken: Getter; workspaces: Workspace[]
  onDelete: (id: string) => void; onChanged: () => void
}) {
  const [dlg, setDlg] = useState(false)
  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Workspaces</SectionLabel>
        <Button style={{ color: tk.accent }} onClick={() => setDlg(true)}>＋ Workspace</Button>
      </div>
      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {workspaces.map(w => (
          <div key={w.id} style={sx.row}>
            <span aria-hidden>🗂️</span>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 600 }}>{w.name}</span> <span style={sx.badge}>{w.baseBranch || 'main'}</span>
              {w.repoUrl && <span style={{ fontSize: text.xs.fontSize, color: tk.muted, marginLeft: space.md }}>{w.repoUrl}</span>}
            </div>
            {w.previewUrl && <a href={w.previewUrl} target="_blank" rel="noreferrer" style={{ ...sx.badge, color: tk.blue, textDecoration: 'none' }}>preview ↗</a>}
            <IconButton aria-label={`Delete workspace ${w.name}`} onClick={() => onDelete(w.id)}>✕</IconButton>
          </div>
        ))}
        {workspaces.length === 0 && <p style={{ ...sx.empty, padding: `${space.md}px 0` }}>No workspaces — define a repo; runtimes get an operator branch + worktree per task.</p>}
      </Card>
      {dlg && <WorkspaceDialog orgId={orgId} getToken={getToken} onClose={() => setDlg(false)} onDone={() => { setDlg(false); onChanged() }} />}
    </div>
  )
}
