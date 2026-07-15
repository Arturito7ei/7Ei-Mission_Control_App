'use client'
// MCA-80 — goal-driven hiring: prompt → proposed profile → confirm hire.
// External-runtime hires return a one-time token + host run block.
import { useState } from 'react'
import { api, API } from '@/lib/api'
import { adapterProfile, runBlock, honorsShellFlag } from '@/lib/adapterProfile'
import { tk, text, space } from '../tokens'
import { Button, TextArea, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, RUNTIME_BADGE, sx, type Getter } from './shared'

export default function HireDialog({ orgId, getToken, onClose, onDone }: { orgId: string; getToken: Getter; onClose: () => void; onDone: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [proposal, setProposal] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Shell execution is OFF by default for new agents; the operator opts in here.
  const [allowShell, setAllowShell] = useState(false)

  const propose = async () => {
    if (!prompt.trim()) return
    setBusy(true); setErr(null)
    try {
      const r = await api<{ proposal: any }>(`/api/orgs/${orgId}/agents/hire`, { token: await getToken(), method: 'POST', body: JSON.stringify({ prompt }) })
      setProposal(r.proposal)
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  const confirmHire = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api<{ agentToken?: string }>(`/api/orgs/${orgId}/agents/hire`, { token: await getToken(), method: 'POST', body: JSON.stringify({ confirm: true, profile: proposal }) })
      if (r.agentToken) setToken(r.agentToken); else onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  const set = (k: string, v: string) => setProposal((p: any) => ({ ...p, [k]: v }))

  return (
    <Modal onClose={onClose}>
      {token ? (() => {
        const rt = proposal?.runtime || 'openclaw'
        const block = runBlock(rt, API, token, { allowShell })
        const note = adapterProfile(rt).note
        return (
          <>
            <ModalTitle>✓ {proposal?.name} imported</ModalTitle>
            <p style={sx.hint}>One-time token (shown once). Copy the block, drop it on the {rt} host, and the agent is live. {note}</p>
            {honorsShellFlag(rt) && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: space.sm, fontSize: text.xs.fontSize, color: tk.textDim, cursor: 'pointer', marginTop: space.md }}>
                <input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} style={{ marginTop: 2 }} />
                <span>Allow shell execution on the host (<code style={sx.code}>MC_ALLOW_SHELL=1</code>) — advanced. Off by default; only enable for an agent you intend to run host commands.</span>
              </label>
            )}
            <Button style={{ color: tk.accent, alignSelf: 'flex-start', marginTop: space.md }} onClick={() => { navigator.clipboard?.writeText(block); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? '✓ Copied' : '📋 Copy env + run command'}</Button>
            <pre style={sx.pre}>{block}</pre>
            <Button variant="primary" style={{ marginTop: space.md }} onClick={onDone}>Done</Button>
          </>
        )
      })() : !proposal ? (
        <>
          <ModalTitle onClose={onClose}>Hire with a prompt</ModalTitle>
          <p style={sx.hint}>Describe the agent you need — Arturito proposes a profile, title, and manager from your org chart.</p>
          <TextArea aria-label="Describe the agent to hire" style={{ minHeight: 90, marginTop: space.lg }} autoFocus value={prompt}
            placeholder="e.g. A growth marketer who owns SEO and the weekly newsletter, reporting to the CMO."
            onChange={e => setPrompt(e.target.value)} />
          {err && <div style={sx.err}>⚠ {err}</div>}
          <Button variant="primary" style={{ marginTop: space.md }} disabled={busy} onClick={propose}>{busy ? 'Designing…' : '✨ Propose'}</Button>
        </>
      ) : (
        <>
          <ModalTitle onClose={onClose}>Review &amp; hire</ModalTitle>
          <div style={sx.form}>
            <div style={{ display: 'flex', gap: space.md }}>
              <FormLabel style={{ flex: 1 }}>Name<TextInput value={proposal.name} onChange={e => set('name', e.target.value)} /></FormLabel>
              <FormLabel style={{ width: 80 }}>Emoji<TextInput value={proposal.avatarEmoji} onChange={e => set('avatarEmoji', e.target.value)} /></FormLabel>
            </div>
            <FormLabel>Title<TextInput value={proposal.title} onChange={e => set('title', e.target.value)} /></FormLabel>
            <FormLabel>Role<TextInput value={proposal.role} onChange={e => set('role', e.target.value)} /></FormLabel>
            <div style={{ fontSize: text.sm.fontSize, color: tk.textDim, lineHeight: 1.7 }}>
              <div>Runtime: <b style={{ color: tk.text }}>{RUNTIME_BADGE[proposal.runtime] ?? '⚙️'} {proposal.runtime}</b> · Model: <b style={{ color: tk.text }}>{proposal.llmProvider}·{proposal.llmModel}</b></div>
              <div>Reports to: <b style={{ color: tk.text }}>{proposal.reportsTo ?? '— (top level)'}</b></div>
              {proposal.skills?.length ? <div>Skills: {proposal.skills.join(', ')}</div> : null}
              {proposal.jobDescription ? <div style={{ color: tk.muted, marginTop: space.xs }}>{proposal.jobDescription}</div> : null}
            </div>
          </div>
          {err && <div style={sx.err}>⚠ {err}</div>}
          <div style={{ display: 'flex', gap: space.md, marginTop: space.xl }}>
            <Button style={{ color: tk.accent }} onClick={() => setProposal(null)}>← Re-prompt</Button>
            <Button variant="primary" disabled={busy} onClick={confirmHire}>{busy ? 'Hiring…' : 'Hire'}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
