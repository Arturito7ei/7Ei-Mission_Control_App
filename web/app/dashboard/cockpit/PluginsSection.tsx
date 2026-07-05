'use client'
// MCA-80 — installed plugins (capability-gated) with On/Off toggle + manifest
// install dialog. Toggle/delete are optimistic and owned by the composition
// root; manifest validation errors surface via api()'s `errors` array mapping.
import { useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, IconButton, SectionLabel, TextArea } from '../ui'
import { Modal, ModalTitle, sx, type Getter, type Plugin } from './shared'

const SAMPLE_MANIFEST = `{
  "name": "weekly-report",
  "version": "1.0.0",
  "description": "Posts a weekly summary",
  "capabilities": ["read:tasks", "notify"],
  "tools": [{ "name": "generate", "description": "Build the report" }]
}`

function PluginDialog({ orgId, getToken, onClose, onDone }: { orgId: string; getToken: Getter; onClose: () => void; onDone: () => void }) {
  const [text_, setText] = useState(SAMPLE_MANIFEST)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const install = async () => {
    setBusy(true); setErr(null)
    let manifest: any
    try { manifest = JSON.parse(text_) } catch { setErr('Manifest is not valid JSON'); setBusy(false); return }
    try {
      await api(`/api/orgs/${orgId}/plugins`, { token: await getToken(), method: 'POST', body: JSON.stringify({ manifest }) })
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  return (
    <Modal onClose={onClose} maxWidth={520}>
      <ModalTitle onClose={onClose}>Install plugin</ModalTitle>
      <p style={sx.hint}>Paste a manifest. Capabilities are gated to an allow-list; unknown ones are rejected.</p>
      <TextArea aria-label="Plugin manifest JSON" style={{ minHeight: 200, marginTop: space.md, fontFamily: 'monospace', fontSize: text.sm.fontSize }} value={text_} onChange={e => setText(e.target.value)} />
      {err && <div style={sx.err}>⚠ {err}</div>}
      <Button variant="primary" style={{ marginTop: space.md }} disabled={busy} onClick={install}>{busy ? 'Installing…' : 'Install'}</Button>
    </Modal>
  )
}

export default function PluginsSection({ orgId, getToken, plugins, onToggle, onDelete, onChanged }: {
  orgId: string; getToken: Getter; plugins: Plugin[]
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  onChanged: () => void
}) {
  const [dlg, setDlg] = useState(false)
  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Plugins</SectionLabel>
        <Button style={{ color: tk.accent }} onClick={() => setDlg(true)}>＋ Install plugin</Button>
      </div>
      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {plugins.map(p => (
          <div key={p.id} style={sx.row}>
            <span aria-hidden>🧩</span>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 600 }}>{p.name}</span> <span style={{ color: tk.mutedSoft, fontSize: text.xs.fontSize }}>v{p.version}</span>
              <span style={{ fontSize: text.xs.fontSize, color: tk.muted, marginLeft: space.md }}>{p.capabilities.join(', ') || 'no capabilities'}{p.tools.length ? ` · tools: ${p.tools.join(', ')}` : ''}</span>
            </div>
            <IconButton aria-pressed={p.enabled} aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`} style={{ color: p.enabled ? tk.green : tk.muted }} onClick={() => onToggle(p.id, !p.enabled)}>{p.enabled ? 'On' : 'Off'}</IconButton>
            <IconButton aria-label={`Uninstall ${p.name}`} onClick={() => onDelete(p.id)}>✕</IconButton>
          </div>
        ))}
        {plugins.length === 0 && <p style={{ ...sx.empty, padding: `${space.md}px 0` }}>No plugins — install a manifest to extend Mission Control (capability-gated).</p>}
      </Card>
      {dlg && <PluginDialog orgId={orgId} getToken={getToken} onClose={() => setDlg(false)} onDone={() => { setDlg(false); onChanged() }} />}
    </div>
  )
}
