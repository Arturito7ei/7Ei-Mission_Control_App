'use client'
// Epic ONB / ONB6 — the operator's create-invite experience. One paste onboards an
// external agent: the operator picks the allowed runtime(s), single/multi-use and a
// TTL, and gets back — ONCE — the invite token and a copy-able onboarding PROMPT to
// paste into any agent's chat. Plus the list of active invites with a revoke action.
//
// Two ONB6 invariants are visible here:
//  * the adapter picker RENDERS FROM the server registry (GET /api/adapters), never
//    from client-side adapterProfile.ts — `pickableAdapters` filters it.
//  * the raw CLAIMED agent key is NEVER shown here. What is shown once is the invite
//    token and the onboarding prompt — never a claimed agent token (that is minted
//    only when the joining agent claims it, and only the claimer ever sees it).
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  pickableAdapters, unavailableAdapters, inviteStatusChip, buildCreateInviteBody, validateCreateInvite,
  CREATE_INVITE_DEFAULTS, INVITE_MAX_USES, INVITE_MAX_TTL_HOURS,
  type AdapterRegistryEntry, type CreateInviteForm,
} from '@/lib/invites.logic'
import { tk, text, space } from '../tokens'
import { Button, Pill, TextArea, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, sx, type Getter } from './shared'

interface InviteView {
  id: string; status: string; allowedAdapterTypes: string[] | null
  maxUses: number; usesRemaining: number; expiresAt: string; createdAt: string
}
interface CreateResult {
  inviteToken: string; onboardingTextUrl: string; onboardingPrompt: string
  joinEnabled: boolean; onboardingDocPublic: boolean
  invite: InviteView
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button style={{ color: tk.accent }} onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
      {copied ? '✓ Copied' : label}
    </Button>
  )
}

export default function InviteAgentDialog({ orgId, getToken, onClose }: { orgId: string; getToken: Getter; onClose: () => void }) {
  const [mode, setMode] = useState<'create' | 'list'>('create')
  const [adapters, setAdapters] = useState<AdapterRegistryEntry[] | null>(null)
  const [joinEnabled, setJoinEnabled] = useState<boolean | null>(null)
  const [invites, setInvites] = useState<InviteView[]>([])
  const [form, setForm] = useState<CreateInviteForm>(CREATE_INVITE_DEFAULTS)
  const [created, setCreated] = useState<CreateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadInvites = async () => {
    try {
      const r = await api<{ invites: InviteView[] }>(`/api/orgs/${orgId}/agent-invites`, { token: await getToken() })
      setInvites(r.invites ?? [])
    } catch (e: any) { setErr(e?.message ?? 'Failed to load invites') }
  }

  useEffect(() => {
    (async () => {
      const token = await getToken()
      try {
        const [reg, posture] = await Promise.all([
          api<{ adapters: AdapterRegistryEntry[] }>('/api/adapters', { token }),
          api<{ posture: { publicJoinEnabled: boolean } }>(`/api/orgs/${orgId}/onboarding-posture`, { token }).catch(() => null),
        ])
        setAdapters(reg.adapters ?? [])
        setJoinEnabled(posture?.posture?.publicJoinEnabled ?? null)
      } catch (e: any) { setErr(e?.message ?? 'Failed to load adapters') }
      loadInvites()
    })()
  }, [orgId]) // eslint-disable-line react-hooks/exhaustive-deps

  const picks = pickableAdapters(adapters)
  const notYet = unavailableAdapters(adapters)
  const toggleAdapter = (t: string) =>
    setForm(f => ({ ...f, adapterTypes: f.adapterTypes.includes(t) ? f.adapterTypes.filter(x => x !== t) : [...f.adapterTypes, t] }))

  const submit = async () => {
    const problems = validateCreateInvite(form)
    if (problems.length) { setErr(problems.join(' ')); return }
    setBusy(true); setErr(null)
    try {
      const res = await api<CreateResult>(`/api/orgs/${orgId}/agent-invites`, {
        token: await getToken(), method: 'POST', body: JSON.stringify(buildCreateInviteBody(form)),
      })
      setCreated(res)
      loadInvites()
    } catch (e: any) { setErr(e?.message ?? 'Failed to create invite') }
    setBusy(false)
  }

  const revoke = async (id: string) => {
    setInvites(x => x.map(i => i.id === id ? { ...i, status: 'revoked' } : i))
    try { await api(`/api/orgs/${orgId}/agent-invites/${id}/revoke`, { token: await getToken(), method: 'POST' }) }
    catch (e: any) { setErr(e?.message ?? 'Failed to revoke'); loadInvites() }
  }

  // ── The one-time reveal ─────────────────────────────────────────────────────
  if (created) {
    return (
      <Modal onClose={onClose} maxWidth={620}>
        <ModalTitle onClose={onClose}>✓ Invite created</ModalTitle>
        <p style={sx.hint}>
          Shown <b>once</b> and not recoverable — copy the prompt now. There is <b>no agent key here</b>:
          the key is minted only when the joining agent claims it, and only the claimer ever sees it.
        </p>

        {created.joinEnabled === false && (
          <div style={{ ...sx.err, background: 'var(--warn-bg)', borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            ⚠ The public join endpoint is <b>closed</b> on this deployment (hosted profile). The invite and
            prompt are ready, but an agent cannot join until remote onboarding is enabled by the operator.
          </div>
        )}

        <FormLabel style={{ marginTop: space.md }}>Invite token (shown once)
          <div style={sx.tokenBox}>{created.inviteToken}</div>
        </FormLabel>
        <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          <CopyButton value={created.inviteToken} label="📋 Copy token" />
          <CopyButton value={created.onboardingTextUrl} label="📋 Copy doc URL" />
        </div>

        <FormLabel style={{ marginTop: space.lg }}>Onboarding prompt — paste into any agent's chat
          <pre style={{ ...sx.pre, maxHeight: 260, overflow: 'auto' }}>{created.onboardingPrompt}</pre>
        </FormLabel>
        <div style={{ display: 'flex', gap: space.md, marginTop: space.md }}>
          <CopyButton value={created.onboardingPrompt} label="📋 Copy onboarding prompt" />
          <Button variant="primary" style={{ marginLeft: 'auto' }} onClick={() => { setCreated(null); setForm(CREATE_INVITE_DEFAULTS); setMode('list') }}>Done</Button>
        </div>
      </Modal>
    )
  }

  // ── Create form / invite list ───────────────────────────────────────────────
  return (
    <Modal onClose={onClose} maxWidth={560}>
      <ModalTitle onClose={onClose}>Invite an agent</ModalTitle>
      <div style={{ display: 'flex', gap: space.sm, marginTop: space.xs }} role="tablist">
        {(['create', 'list'] as const).map(m => (
          <Button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}
            style={mode === m ? { borderColor: tk.accent, background: 'var(--accent-dim)', color: tk.text } : { background: tk.bg, color: tk.textDim }}>
            {m === 'create' ? 'New invite' : `Active invites${invites.length ? ` · ${invites.filter(i => i.status === 'active').length}` : ''}`}
          </Button>
        ))}
      </div>

      {err && <div style={sx.err}>⚠ {err}</div>}

      {mode === 'create' ? (
        <div style={sx.form}>
          <p style={sx.hint}>
            The operator's whole product is one paste: pick what may join, and you get a prompt to drop into any agent's chat.
            A human still approves every join before a credential exists.
          </p>

          <FormLabel>Allowed runtime(s) — from the server adapter registry
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs }}>
              {adapters === null ? <span style={sx.loading}>Loading adapters…</span>
                : picks.length === 0 ? <span style={sx.empty}>No invitable runtimes available.</span>
                : picks.map(a => {
                  const on = form.adapterTypes.includes(a.type)
                  return (
                    <Button key={a.type} aria-pressed={on} onClick={() => toggleAdapter(a.type)}
                      style={on ? { borderColor: tk.accent, background: 'var(--accent-dim)', color: tk.text } : { background: tk.bg, color: tk.textDim }}>
                      {on ? '✓ ' : ''}{a.label}
                    </Button>
                  )
                })}
            </div>
            <span style={{ fontSize: text.xs.fontSize, color: tk.mutedSoft }}>
              {form.adapterTypes.length === 0 ? 'None selected → any invitable runtime may join.' : `${form.adapterTypes.length} selected.`}
            </span>
          </FormLabel>

          {/* AAD-2 — declared but NOT dispatchable yet. Inert on purpose: Mission
              Control has no way to hand these runtimes work (no outbound WS
              client, no per-agent HTTP pusher, no Hermes client, no xAI provider),
              so an invite naming one could never be spent. Shown rather than
              hidden, with the registry's own reason, so "where is Grok?" has an
              answer instead of an empty space. */}
          {notYet.length > 0 && (
            <div>
              <span style={{ fontSize: text.xs.fontSize, fontWeight: 700, color: tk.muted }}>Not yet available</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs }}>
                {notYet.map(a => (
                  <span key={a.type} title={a.note ?? 'Declared in the adapter registry, but Mission Control cannot dispatch work to it yet.'}
                    aria-disabled="true"
                    style={{ fontSize: text.xs.fontSize, color: tk.mutedSoft, border: `1px dashed ${tk.line}`, borderRadius: 8, padding: '5px 10px' }}>
                    ○ {a.label}
                  </span>
                ))}
              </div>
              <span style={{ fontSize: text.xs.fontSize, color: tk.mutedSoft }}>
                Declared in the adapter registry, but Mission Control cannot hand these runtimes work yet — so they cannot be invited.
              </span>
            </div>
          )}

          <FormLabel>Uses
            <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
              <Button aria-pressed={!form.multiUse} onClick={() => setForm(f => ({ ...f, multiUse: false }))}
                style={!form.multiUse ? { borderColor: tk.accent, background: 'var(--accent-dim)', color: tk.text } : { background: tk.bg, color: tk.textDim }}>
                Single-use (default)
              </Button>
              <Button aria-pressed={form.multiUse} onClick={() => setForm(f => ({ ...f, multiUse: true }))}
                style={form.multiUse ? { borderColor: tk.accent, background: 'var(--accent-dim)', color: tk.text } : { background: tk.bg, color: tk.textDim }}>
                Multi-use
              </Button>
              {form.multiUse && (
                <TextInput type="number" min={1} max={INVITE_MAX_USES} value={form.uses} style={{ width: 90 }}
                  onChange={e => setForm(f => ({ ...f, uses: Number(e.target.value) }))} aria-label="Max uses" />
              )}
            </div>
          </FormLabel>

          <FormLabel>Time to live (hours) — max {INVITE_MAX_TTL_HOURS}
            <TextInput type="number" min={1} max={INVITE_MAX_TTL_HOURS} value={form.ttlHours} style={{ width: 120 }}
              onChange={e => setForm(f => ({ ...f, ttlHours: Number(e.target.value) }))} />
          </FormLabel>

          <FormLabel>Message (optional) — context for the agent, not an instruction
            <TextArea style={{ minHeight: 56 }} value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))} />
          </FormLabel>

          {joinEnabled === false && (
            <p style={{ fontSize: text.xs.fontSize, color: 'var(--warn)', margin: 0 }}>
              ⚠ Public join is closed on this deployment — the invite will be created, but agents cannot join until remote onboarding is enabled.
            </p>
          )}

          <Button variant="primary" disabled={busy} onClick={submit} style={{ marginTop: space.sm }}>
            {busy ? 'Creating…' : 'Create invite + prompt'}
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: space.md }}>
          {invites.length === 0 ? <p style={sx.empty}>No invites yet.</p> : invites.map(i => {
            const chip = inviteStatusChip(i.status)
            const allow = i.allowedAdapterTypes ? i.allowedAdapterTypes.join(', ') : 'any runtime'
            return (
              <div key={i.id} style={sx.row}>
                <Pill tone={chip.tone}>{chip.icon} {chip.label}</Pill>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: text.sm.fontSize, color: tk.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{allow}</div>
                  <div style={{ fontSize: text.xs.fontSize, color: tk.muted }}>
                    {i.usesRemaining}/{i.maxUses} uses left · expires {new Date(i.expiresAt).toLocaleString()}
                  </div>
                </div>
                {i.status === 'active' && <Button style={{ color: tk.red }} onClick={() => revoke(i.id)}>✕ Revoke</Button>}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
