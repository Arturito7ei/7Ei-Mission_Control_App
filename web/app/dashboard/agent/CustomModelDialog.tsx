'use client'
// Epic AG — define a custom adapter/model for an agent: any OpenAI-compatible
// endpoint (NVIDIA NIM, Together, vLLM, a local server, or a plain OpenAI-standard
// provider). Same shape as Arturita's custom-model insertion (#207) and the same
// backend service behind it — display name, base URL, model id, optional API key.
//
// The key is sent once, stored AES-256-GCM encrypted, and never comes back: the
// server returns a masked tail only. Leaving the field blank on an existing model
// keeps the stored key; that is why the placeholder says so rather than showing
// a fake value the operator might think is real.
import { useState } from 'react'
import { api } from '@/lib/api'
import { Button, TextInput } from '../ui'
import { Modal, ModalTitle, FormLabel, sx } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { ax, type Getter } from './shared'

export type CustomModel = {
  provider: string
  model: string
  label?: string
  baseUrl?: string
  mode?: 'local' | 'provider'
  hasKey?: boolean
}

type Probe = { ok: boolean; status: number | null; detail: string }

export default function CustomModelDialog({ orgId, getToken, existing, onClose, onSaved }: {
  orgId: string
  getToken: Getter
  /** editing an existing entry (key left blank keeps the stored one) */
  existing?: CustomModel | null
  onClose: () => void
  /** the saved entry — the caller selects it as the agent's model */
  onSaved: (m: CustomModel) => void
}) {
  const [label, setLabel] = useState(existing?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [model, setModel] = useState(existing?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const base = `/api/orgs/${orgId}/custom-models`
  const ready = !!model.trim() && !!baseUrl.trim()

  const test = async () => {
    setTesting(true); setErr(null); setProbe(null)
    try {
      setProbe(await api<Probe>(`${base}/test`, {
        token: await getToken(), method: 'POST',
        body: JSON.stringify({
          model: model.trim(), baseUrl: baseUrl.trim(),
          // No key typed + editing → probe with the stored one.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : existing ? { provider: existing.provider } : {}),
        }),
      }))
    } catch (e: any) { setErr(e?.message ?? 'Could not reach the endpoint.') }
    setTesting(false)
  }

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api<{ entry: CustomModel }>(base, {
        token: await getToken(), method: 'POST',
        body: JSON.stringify({
          label: label.trim() || undefined,
          model: model.trim(),
          baseUrl: baseUrl.trim(),
          ...(existing ? { provider: existing.provider } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      })
      onSaved(r.entry)
    } catch (e: any) { setErr(e?.message ?? 'Could not save this model.'); setBusy(false) }
  }

  return (
    <Modal onClose={onClose}>
      <ModalTitle onClose={onClose}>{existing ? 'Edit custom model' : 'Add a custom model'}</ModalTitle>

      <p style={{ ...ax.empty, fontSize: text.xs.fontSize, maxWidth: 460 }}>
        Any OpenAI-compatible endpoint — NVIDIA NIM, Together, vLLM, a local server, or an OpenAI-standard provider.
        The 7Ei executor calls it directly on this agent’s runs.
      </p>

      {err && <div style={ax.err}>{err}</div>}

      <FormLabel>Display name <span style={{ fontWeight: 400, color: tk.muted }}>· optional</span>
        <TextInput value={label} placeholder="NVIDIA Llama 3.3 70B" onChange={e => setLabel(e.target.value)} />
      </FormLabel>

      <FormLabel>Base URL <span style={{ fontWeight: 400, color: tk.muted }}>· the OpenAI-compatible root, ending in /v1</span>
        <TextInput value={baseUrl} placeholder="https://integrate.api.nvidia.com/v1" inputMode="url"
          onChange={e => { setBaseUrl(e.target.value); setProbe(null) }} />
      </FormLabel>

      <FormLabel>Model id <span style={{ fontWeight: 400, color: tk.muted }}>· exactly as the provider names it</span>
        <TextInput value={model} placeholder="meta/llama-3.3-70b-instruct"
          onChange={e => { setModel(e.target.value); setProbe(null) }} />
      </FormLabel>

      <FormLabel>API key <span style={{ fontWeight: 400, color: tk.muted }}>· optional — a local endpoint may need none</span>
        <TextInput type="password" value={apiKey} autoComplete="off"
          placeholder={existing?.hasKey ? 'A key is stored — leave blank to keep it' : 'nvapi-…'}
          onChange={e => { setApiKey(e.target.value); setProbe(null) }} />
      </FormLabel>
      <p style={{ ...ax.empty, fontSize: text.xs.fontSize }}>
        The key is encrypted (AES-256-GCM) before it is stored, and is never shown or logged again.
      </p>

      {/* Result is stated in words and marked with a glyph — never colour alone. */}
      {probe && (
        <div style={{
          ...sx.badge, display: 'flex', gap: space.sm, alignItems: 'center', padding: `${space.sm}px ${space.md}px`,
          color: probe.ok ? tk.green : tk.red, borderColor: probe.ok ? tk.green : tk.red, whiteSpace: 'normal',
        }}>
          <span aria-hidden="true">{probe.ok ? '✓' : '✕'}</span>
          <span>{probe.ok ? 'Reachable' : 'Failed'} — {probe.detail}{probe.status ? ` (HTTP ${probe.status})` : ''}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: space.sm, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={test} disabled={!ready || testing || busy}>{testing ? 'Testing…' : 'Test connection'}</Button>
        <Button variant="primary" onClick={save} disabled={!ready || busy}>
          {busy ? 'Saving…' : existing ? 'Save model' : 'Add model'}
        </Button>
      </div>
    </Modal>
  )
}
