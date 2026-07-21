'use client'
// Epic AG / AG5 — Configuration tab: avatar, identity, reports-to (feeds the org
// chart), and the adapter + model in use. Writes through the owner-gated,
// field-allowlisted `PUT …/agents/:id/config` — not the legacy unvalidated PATCH.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, API } from '@/lib/api'
import { ACCEPTED_UPLOAD_TYPES, downscaleAvatar, isAcceptedUpload } from '@/lib/avatarImage'
import { Button, Card, Select, Skeleton, TextArea, TextInput } from '../ui'
import { FormLabel, sx } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { AgentAvatar, ax, type DAgent, type Getter } from './shared'
import CustomModelDialog, { type CustomModel } from './CustomModelDialog'
import DeleteAgentDialog from './DeleteAgentDialog'
import { useOrgRole } from '../useOrgRole'
import { NON_OWNER_DELETE_NOTE, UNKNOWN_ROLE_DELETE_NOTE, canDeleteAgent } from '@/lib/agentDelete'

type Roster = { id: string; name: string; role: string; avatarEmoji?: string | null; reportsTo?: string | null }
type ModelOption = { id: string; label: string; provider: string; tier: string; custom?: boolean }

const ADAPTERS: { value: string; label: string }[] = [
  { value: 'internal', label: 'Internal — the 7Ei executor (LLM API)' },
  { value: 'openclaw', label: 'OpenClaw — local BYO runtime' },
  { value: 'claude_code', label: 'Claude Code — local coding agent' },
  { value: 'cursor', label: 'Cursor — local BYO runtime' },
  { value: 'custom', label: 'Custom runtime' },
]

export default function ConfigurationTab({ orgId, agentId, getToken, onSaved, onDeleted }: {
  orgId: string
  agentId: string
  getToken: Getter
  onSaved?: () => void
  /** AAD-2 — the agent is gone: leave this page and refresh the roster. Absent →
   *  the Delete control is not offered at all (nowhere to route back to). */
  onDeleted?: () => void
}) {
  const [agent, setAgent] = useState<DAgent | null>(null)
  const [roster, setRoster] = useState<Roster[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [custom, setCustom] = useState<CustomModel[]>([])
  const [dialog, setDialog] = useState<{ open: boolean; editing: CustomModel | null }>({ open: false, editing: null })
  const [form, setForm] = useState({ name: '', title: '', role: '', jobDescription: '', avatarEmoji: '', reportsTo: '', runtime: 'internal', model: '', contactChannel: '' })
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // AAD-2 — the owner gate for the Delete control. The role is the SERVER's
  // answer (see useOrgRole); `null` means unresolved and offers nothing.
  const { isOwner, role, loading: roleLoading } = useOrgRole(orgId, getToken)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const token = await getToken()
      const [{ agent: a }, { agents }] = await Promise.all([
        api<{ agent: DAgent }>(`/api/agents/${agentId}`, { token }),
        api<{ agents: Roster[] }>(`/api/orgs/${orgId}/agents`, { token }),
      ])
      setAgent(a)
      setRoster(agents)
      setForm({
        name: a.name ?? '', title: a.title ?? '', role: a.role ?? '',
        jobDescription: a.jobDescription ?? '', avatarEmoji: a.avatarEmoji ?? '',
        reportsTo: a.reportsTo ?? '', runtime: a.runtime ?? 'internal',
        model: a.primaryModel || a.llmModel || '',
        contactChannel: a.contactChannel ?? '',
      })
      try {
        const [{ models: m }, { models: c }] = await Promise.all([
          api<{ models: ModelOption[] }>(`/api/orgs/${orgId}/available-models`, { token }),
          api<{ models: CustomModel[] }>(`/api/orgs/${orgId}/custom-models`, { token }),
        ])
        setModels(m)
        setCustom(c)
      } catch { /* the model picker degrades to the current value */ }
    } catch (e: any) { setErr(e?.message ?? 'Could not load this agent’s configuration.') }
  }, [orgId, agentId, getToken])

  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false)
    const chosen = models.find(m => m.id === form.model)
    try {
      const { agent: a } = await api<{ agent: DAgent }>(`/api/orgs/${orgId}/agents/${agentId}/config`, {
        token: await getToken(), method: 'PUT',
        body: JSON.stringify({
          name: form.name, title: form.title, role: form.role,
          jobDescription: form.jobDescription, avatarEmoji: form.avatarEmoji,
          reportsTo: form.reportsTo, runtime: form.runtime, contactChannel: form.contactChannel,
          ...(form.model ? { llmModel: form.model, primaryModel: form.model, ...(chosen ? { llmProvider: chosen.provider } : {}) } : {}),
        }),
      })
      setAgent(a); setSaved(true); onSaved?.()
    } catch (e: any) { setErr(e?.message ?? 'Could not save the configuration.') }
    setBusy(false)
  }

  // Upload: downscale in the browser first (a 4MB photo lands as ~20KB), then
  // multipart to the owner-gated avatar route. The backend caps + validates too.
  const upload = async (file: File) => {
    if (!isAcceptedUpload(file.type)) { setErr('Use a PNG, JPEG, WebP or GIF image.'); return }
    setUploading(true); setErr(null); setSaved(false)
    try {
      const blob = await downscaleAvatar(file)
      const fd = new FormData()
      fd.append('file', blob, file.name)
      const res = await fetch(`${API}/api/orgs/${orgId}/agents/${agentId}/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}` }, // no Content-Type: the browser sets the multipart boundary
        body: fd,
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? 'Upload failed.')
      setAgent(a => a ? { ...a, avatarUrl: j.avatarUrl } : a)
      onSaved?.()
    } catch (e: any) { setErr(e?.message ?? 'Could not upload that picture.') }
    setUploading(false)
  }

  // A model saved from the dialog is immediately selected as this agent's model:
  // adding one and then having to find it in the dropdown is a step with no
  // purpose. It is not persisted on the agent until Save changes — same as every
  // other field on this page.
  const onCustomSaved = async (m: CustomModel) => {
    setDialog({ open: false, editing: null })
    await load()
    setForm(f => ({ ...f, model: m.model }))
    setSaved(false)
  }

  const removeCustom = async (provider: string) => {
    setBusy(true); setErr(null)
    try {
      const r = await api<{ stranded: { id: string; name: string }[] }>(`/api/orgs/${orgId}/custom-models/${encodeURIComponent(provider)}`,
        { token: await getToken(), method: 'DELETE' })
      await load()
      // Deleting the endpoint does not un-point the agents at it — say so rather
      // than let them fail at run time.
      if (r.stranded?.length) {
        setErr(`Removed. ${r.stranded.map(a => a.name).join(', ')} ${r.stranded.length === 1 ? 'is' : 'are'} still set to this model and will fail to run until you pick another.`)
      }
    } catch (e: any) { setErr(e?.message ?? 'Could not remove that model.') }
    setBusy(false)
  }

  const removeAvatar = async () => {
    setUploading(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/agents/${agentId}/avatar`, { token: await getToken(), method: 'DELETE' })
      setAgent(a => a ? { ...a, avatarUrl: null } : a)
      onSaved?.()
    } catch (e: any) { setErr(e?.message ?? 'Could not remove the picture.') }
    setUploading(false)
  }

  if (err && !agent) return <div style={ax.err}>{err}</div>
  if (!agent) return <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}><Skeleton h={120} /><Skeleton h={220} /></div>

  // Self can't be your own manager; the backend also refuses deeper loops.
  const managers = roster.filter(r => r.id !== agentId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xl }}>
      {err && <div style={ax.err}>{err}</div>}

      {/* ── Avatar ─────────────────────────────────────────────────────── */}
      <section>
        <h2 style={{ ...ax.sectionTitle, marginBottom: space.sm }}>Avatar</h2>
        <Card style={{ display: 'flex', alignItems: 'center', gap: space.xl, flexWrap: 'wrap' }}>
          <AgentAvatar agent={{ ...agent, avatarEmoji: form.avatarEmoji || agent.avatarEmoji }} size={96} radius={16} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
            <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
              <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? 'Uploading…' : agent.avatarUrl ? 'Replace picture' : 'Upload picture'}
              </Button>
              {agent.avatarUrl && <Button variant="danger" onClick={removeAvatar} disabled={uploading}>Remove</Button>}
              <input ref={fileRef} type="file" accept={ACCEPTED_UPLOAD_TYPES.join(',')} style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
            </div>
            <p style={{ ...ax.empty, fontSize: text.xs.fontSize, maxWidth: 420 }}>
              PNG, JPEG, WebP or GIF. The picture is resized to 256px before upload and shown on the staff grid and this
              page. With no picture, the agent falls back to its icon below.
            </p>
          </div>
        </Card>
      </section>

      {/* ── Identity ───────────────────────────────────────────────────── */}
      <section>
        <h2 style={{ ...ax.sectionTitle, marginBottom: space.sm }}>Identity</h2>
        <Card style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: space.lg }}>
            <FormLabel>Name
              <TextInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </FormLabel>
            <FormLabel>Icon <span style={{ fontWeight: 400, color: tk.muted }}>· used when there is no picture</span>
              <TextInput value={form.avatarEmoji} placeholder="🤖" onChange={e => setForm({ ...form, avatarEmoji: e.target.value })} />
            </FormLabel>
            <FormLabel>Role
              <TextInput value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} />
            </FormLabel>
            <FormLabel>Title
              <TextInput value={form.title} placeholder="e.g. VP of Engineering" onChange={e => setForm({ ...form, title: e.target.value })} />
            </FormLabel>
          </div>
          <FormLabel>Email <span style={{ fontWeight: 400, color: tk.muted }}>· shown on the staff grid; blank falls back to an @handle</span>
            <TextInput value={form.contactChannel} placeholder="agent@7ei.ai" inputMode="email"
              onChange={e => setForm({ ...form, contactChannel: e.target.value })} />
          </FormLabel>
          <FormLabel>Description
            <TextArea value={form.jobDescription} placeholder="Describe what this agent can do…"
              onChange={e => setForm({ ...form, jobDescription: e.target.value })} style={{ minHeight: 78 }} />
          </FormLabel>
          <FormLabel>Reports to <span style={{ fontWeight: 400, color: tk.muted }}>· sets this agent’s place in the org chart</span>
            <Select value={form.reportsTo} onChange={e => setForm({ ...form, reportsTo: e.target.value })}>
              <option value="">— nobody (top of the chart)</option>
              {managers.map(m => <option key={m.id} value={m.id}>{m.avatarEmoji ?? '🤖'} {m.name} — {m.role}</option>)}
            </Select>
          </FormLabel>
        </Card>
      </section>

      {/* ── Adapter + model ────────────────────────────────────────────── */}
      <section>
        <h2 style={{ ...ax.sectionTitle, marginBottom: space.sm }}>Adapter</h2>
        <Card style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: space.lg }}>
          <FormLabel>Adapter type
            <Select value={form.runtime} onChange={e => setForm({ ...form, runtime: e.target.value })}>
              {ADAPTERS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          </FormLabel>
          <FormLabel>Model <span style={{ fontWeight: 400, color: tk.muted }}>· the LLM this agent runs on</span>
            <Select value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}>
              {/* Keep the current value selectable even if it isn't in the catalogue. */}
              {form.model && !models.some(m => m.id === form.model) && <option value={form.model}>{form.model} (current)</option>}
              {models.map(m => <option key={m.id} value={m.id}>{m.label} · {m.tier}{m.custom ? ' · custom' : ''}</option>)}
            </Select>
          </FormLabel>
        </Card>
        <p style={{ ...ax.empty, fontSize: text.xs.fontSize, marginTop: space.sm }}>
          A local/BYO adapter (OpenClaw, Claude Code, Cursor) runs on the operator’s machine and claims tasks over the
          agent API; the internal adapter runs on the 7Ei backend.
        </p>

        {/* ── Custom models ──────────────────────────────────────────────
            An operator-defined OpenAI-compatible endpoint. It is a MODEL, not a
            runtime: the internal executor calls it. Kept next to the picker it
            feeds, rather than buried in org settings. */}
        <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md, marginTop: space.lg, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md, padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${tk.line}` }}>
            <span style={{ fontSize: text.sm.fontSize, fontWeight: 700 }}>Custom models</span>
            <Button onClick={() => setDialog({ open: true, editing: null })}>＋ Add a custom model</Button>
          </div>

          {custom.length === 0 ? (
            <p style={{ ...ax.empty, fontSize: text.xs.fontSize, padding: `0 ${space.lg}px ${space.lg}px` }}>
              None yet. Add any OpenAI-compatible endpoint — NVIDIA NIM, Together, vLLM, a local server, or an
              OpenAI-standard provider — and it becomes selectable in the Model list above.
            </p>
          ) : custom.map(m => (
            <div key={m.provider} style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: `${space.md}px ${space.lg}px`, borderTop: `1px solid ${tk.line}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: text.md.fontSize, fontWeight: 600 }}>{m.label || m.model}</span>
                  {form.model === m.model && <span style={{ ...sx.badge, color: tk.accent, borderColor: 'var(--accent-line)' }}>IN USE</span>}
                  {/* Whether a key is stored is a fact the operator needs; the key itself never comes back. */}
                  <span style={sx.badge}>{m.hasKey ? '🔒 key stored' : 'no key'}</span>
                </div>
                <div style={{ fontSize: text.xs.fontSize, color: tk.muted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.model} · {m.baseUrl}
                </div>
              </div>
              <Button onClick={() => setDialog({ open: true, editing: m })} disabled={busy}>Edit</Button>
              <Button variant="danger" onClick={() => removeCustom(m.provider)} disabled={busy}>Remove</Button>
            </div>
          ))}
        </Card>
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: space.lg }}>
        <Button variant="primary" onClick={save} disabled={busy || !form.name.trim() || !form.role.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        {saved && <span style={{ color: tk.green, fontSize: text.sm.fontSize }}>✓ Saved</span>}
      </div>

      {/* ── Danger zone (AAD-2) ─────────────────────────────────────────
          Owner-only, and gated on the SERVER's answer about this caller —
          `canDeleteAgent` fails closed, so an unresolved role offers nothing
          rather than a button that would only ever collect a 403. Last on the
          page, below the save bar, so it is never on the path to a normal edit. */}
      {onDeleted && (
        <section>
          <h2 style={{ ...ax.sectionTitle, marginBottom: space.sm, color: tk.red }}>Danger zone</h2>
          <Card style={{ display: 'flex', alignItems: 'center', gap: space.lg, flexWrap: 'wrap', borderColor: 'var(--danger-line, var(--line-strong))' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: text.md.fontSize, fontWeight: 600 }}>Delete this agent</div>
              <p style={{ ...ax.empty, fontSize: text.xs.fontSize, maxWidth: 520, margin: `${space.xs}px 0 0` }}>
                Removes {agent.name} from the organisation and <b>revokes its connected credentials</b> — its API token,
                OAuth tokens and agent-scoped secrets. History is retained for the audit trail; there is no restore in the app.
              </p>
              {!roleLoading && !canDeleteAgent(role) && (
                <p style={{ ...ax.empty, fontSize: text.xs.fontSize, maxWidth: 520, margin: `${space.sm}px 0 0` }}>
                  {isOwner === false ? NON_OWNER_DELETE_NOTE : UNKNOWN_ROLE_DELETE_NOTE}
                </p>
              )}
            </div>
            {canDeleteAgent(role) && (
              <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={busy || uploading}>
                Delete agent…
              </Button>
            )}
          </Card>
        </section>
      )}

      {deleteOpen && onDeleted && (
        <DeleteAgentDialog orgId={orgId} agentId={agentId} agentName={agent.name} getToken={getToken}
          onClose={() => setDeleteOpen(false)} onDeleted={() => { setDeleteOpen(false); onDeleted() }} />
      )}

      {dialog.open && (
        <CustomModelDialog orgId={orgId} getToken={getToken} existing={dialog.editing}
          onClose={() => setDialog({ open: false, editing: null })} onSaved={onCustomSaved} />
      )}
    </div>
  )
}
