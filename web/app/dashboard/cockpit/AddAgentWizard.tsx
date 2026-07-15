'use client'
// MCA-80 — external-runtime onboarding wizard (Identity → Runtime → Model →
// Review). POSTs /api/orgs/:id/agents/external and shows the one-time agent
// token + mc.env block exactly once.
import { useState } from 'react'
import { api, API } from '@/lib/api'
import { adapterProfile, runBlock, honorsShellFlag } from '@/lib/adapterProfile'
import { tk, text, space } from '../tokens'
import { Button, TextArea, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, RUNTIME_BADGE, sx, type Getter } from './shared'

const RUNTIMES = [
  { id: 'openclaw', label: 'OpenClaw', emoji: '📎', defModel: 'MiniMax-Text-01', defProvider: 'minimax' },
  { id: 'cursor', label: 'Cursor', emoji: '⌨️', defModel: 'claude-sonnet-4-20250514', defProvider: 'anthropic' },
  { id: 'claude_code', label: 'Claude Code', emoji: '🤖', defModel: 'claude-sonnet-4-20250514', defProvider: 'anthropic' },
  { id: 'custom', label: 'Custom', emoji: '⚙️', defModel: 'minimax', defProvider: 'custom' },
]

export default function AddAgentWizard({ orgId, getToken, onClose, onDone }: { orgId: string; getToken: Getter; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [f, setF] = useState({ name: 'Arturito · Open Claw', role: 'Ops', runtime: 'openclaw', llmProvider: 'minimax', llmModel: 'MiniMax-Text-01', termsOfReference: '', avatarEmoji: '📎', externalEndpoint: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Shell execution is OFF by default for new agents; the operator opts in here.
  const [allowShell, setAllowShell] = useState(false)

  const pickRuntime = (r: typeof RUNTIMES[number]) =>
    setF({ ...f, runtime: r.id, llmProvider: r.defProvider, llmModel: r.defModel, avatarEmoji: r.emoji })

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      // Only send externalEndpoint when provided (schema expects a URL or omit).
      const { externalEndpoint, ...rest } = f
      const body = externalEndpoint.trim() ? { ...rest, externalEndpoint: externalEndpoint.trim() } : rest
      const res = await api<{ agentToken: string }>(`/api/orgs/${orgId}/agents/external`, { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
      setToken(res.agentToken)
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }

  // CC4 — the run block now matches the picked runtime's real adapter (claude_code
  // no longer falls through to the OpenClaw command).
  const envSnippet = token ? runBlock(f.runtime, API, token, { allowShell }) : ''
  const runtimeNote = adapterProfile(f.runtime).note
  const shellCapable = honorsShellFlag(f.runtime)

  return (
    <Modal onClose={onClose}>
      {token ? (
        <>
          <ModalTitle>✓ {f.name} onboarded</ModalTitle>
          <p style={sx.hint}>Copy this agent token now — it is shown only once. Paste it into the runtime's <code style={sx.code}>mc.env</code>. {runtimeNote}</p>
          <div style={sx.tokenBox}>{token}</div>
          {shellCapable && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: space.sm, fontSize: text.xs.fontSize, color: tk.textDim, cursor: 'pointer' }}>
              <input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} style={{ marginTop: 2 }} />
              <span>Allow shell execution on the host (<code style={sx.code}>MC_ALLOW_SHELL=1</code>) — advanced. Off by default; only enable for an agent you intend to run host commands.</span>
            </label>
          )}
          <Button style={{ color: tk.accent, alignSelf: 'flex-start' }} onClick={() => { navigator.clipboard?.writeText(envSnippet); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? '✓ Copied env' : '📋 Copy mc.env block'}
          </Button>
          <pre style={sx.pre}>{envSnippet}</pre>
          <Button variant="primary" style={{ marginTop: space.md }} onClick={onDone}>Done</Button>
        </>
      ) : (
        <>
          <ModalTitle onClose={onClose}>Add an agent</ModalTitle>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, margin: `${space.md}px 0 ${space.xs}px` }} role="list" aria-label="Wizard steps">
            {['Identity', 'Runtime', 'Model', 'Review'].map((label, i) => (
              <span key={label} role="listitem" style={{
                fontSize: text.xs.fontSize, borderRadius: tk.r.pill, padding: '2px 9px',
                ...(i === step
                  ? { color: tk.accentContrast, background: tk.accent, border: `1px solid ${tk.accent}`, fontWeight: 700 }
                  : { color: tk.muted, background: tk.surfaceHigh, border: '1px solid var(--line-strong)' }),
              }}>{i + 1}. {label}</span>
            ))}
          </div>

          {step === 0 && (
            <div style={sx.form}>
              <FormLabel>Name<TextInput value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></FormLabel>
              <FormLabel>Role<TextInput value={f.role} onChange={e => setF({ ...f, role: e.target.value })} /></FormLabel>
              <FormLabel>Terms of reference (optional)<TextArea style={{ minHeight: 60 }} value={f.termsOfReference} onChange={e => setF({ ...f, termsOfReference: e.target.value })} /></FormLabel>
            </div>
          )}
          {step === 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.md, marginTop: space.lg }}>
              {RUNTIMES.map(r => (
                <Button key={r.id} aria-pressed={f.runtime === r.id} onClick={() => pickRuntime(r)}
                  style={f.runtime === r.id
                    ? { borderColor: tk.accent, background: 'var(--accent-dim)', color: tk.text }
                    : { background: tk.bg, color: tk.textDim }}>
                  {r.emoji} {r.label}
                </Button>
              ))}
            </div>
          )}
          {step === 2 && (
            <div style={sx.form}>
              <FormLabel>LLM provider<TextInput value={f.llmProvider} onChange={e => setF({ ...f, llmProvider: e.target.value })} /></FormLabel>
              <FormLabel>Model<TextInput value={f.llmModel} onChange={e => setF({ ...f, llmModel: e.target.value })} /></FormLabel>
              <FormLabel>External endpoint (optional)<TextInput value={f.externalEndpoint} placeholder="https://… — a push URL for task nudges (adapter still polls)" onChange={e => setF({ ...f, externalEndpoint: e.target.value })} /></FormLabel>
              <p style={{ fontSize: text.xs.fontSize, color: tk.mutedSoft, margin: 0 }}>External runtimes run their own brain; this is metadata + the model the adapter calls.</p>
            </div>
          )}
          {step === 3 && (
            <div style={{ ...sx.form, fontSize: text.md.fontSize, color: tk.textDim }}>
              <div>Name: <b style={{ color: tk.text }}>{f.name}</b></div>
              <div>Role: <b style={{ color: tk.text }}>{f.role}</b></div>
              <div>Runtime: <b style={{ color: tk.text }}>{RUNTIME_BADGE[f.runtime]} {f.runtime}</b></div>
              <div>Model: <b style={{ color: tk.text }}>{f.llmProvider} · {f.llmModel}</b></div>
              <p style={{ fontSize: text.xs.fontSize, color: tk.mutedSoft, margin: `${space.sm}px 0 0` }}>On create you'll get a one-time agent token for the adapter.</p>
            </div>
          )}
          {err && <div style={sx.err}>⚠ {err}</div>}

          <div style={{ display: 'flex', gap: space.md, marginTop: space.xl }}>
            {step > 0 && <Button style={{ color: tk.accent }} onClick={() => setStep(step - 1)}>← Back</Button>}
            {step < 3
              ? <Button variant="primary" onClick={() => setStep(step + 1)}>Next →</Button>
              : <Button variant="primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create agent'}</Button>}
          </div>
        </>
      )}
    </Modal>
  )
}
