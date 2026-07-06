'use client'
// MCA-80 — goal tree + new-goal dialog. Dialog-open state is local; data and
// reload flow from the composition root.
import { useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel, Select, TextArea, TextInput } from '../ui'
import { FormLabel, Modal, ModalTitle, sx, type Getter, type GoalNode } from './shared'

function NodeRow({ node, depth }: { node: GoalNode; depth: number }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: `${space.xs}px 0`, paddingLeft: depth * 20 }}>
        {depth > 0 && <span aria-hidden style={{ color: tk.muted }}>└─</span>}
        <span aria-hidden>🎯</span>
        <span style={{ fontWeight: 600, fontSize: text.md.fontSize }}>{node.title}</span>
        {node.metric && <span style={sx.badge}>{node.metric}</span>}
        {node.status && node.status !== 'active' && <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{node.status}</span>}
      </div>
      {node.children.map(c => <NodeRow key={c.id} node={c} depth={depth + 1} />)}
    </>
  )
}

function flattenGoals(nodes: GoalNode[], depth = 0, acc: { id: string; label: string }[] = []) {
  for (const n of nodes) { acc.push({ id: n.id, label: `${'— '.repeat(depth)}${n.title}` }); flattenGoals(n.children, depth + 1, acc) }
  return acc
}

function GoalDialog({ orgId, getToken, goals, onClose, onDone }: { orgId: string; getToken: Getter; goals: GoalNode[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: '', metric: '', description: '', parentGoalId: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const opts = flattenGoals(goals)
  const save = async () => {
    if (!f.title.trim()) return
    setBusy(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/goals`, { token: await getToken(), method: 'POST', body: JSON.stringify({ title: f.title, metric: f.metric || undefined, description: f.description || undefined, parentGoalId: f.parentGoalId || undefined }) })
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  return (
    <Modal onClose={onClose}>
      <ModalTitle onClose={onClose}>New goal</ModalTitle>
      <div style={sx.form}>
        <FormLabel>Goal<TextInput autoFocus value={f.title} placeholder="Build the #1 AI note-taking app" onChange={e => setF({ ...f, title: e.target.value })} /></FormLabel>
        <FormLabel>Success metric<TextInput value={f.metric} placeholder="$1M MRR" onChange={e => setF({ ...f, metric: e.target.value })} /></FormLabel>
        <FormLabel>Parent goal
          <Select value={f.parentGoalId} onChange={e => setF({ ...f, parentGoalId: e.target.value })}>
            <option value="">— top level —</option>
            {opts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </FormLabel>
        <FormLabel>Description<TextArea style={{ minHeight: 56 }} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></FormLabel>
      </div>
      {err && <div style={sx.err}>⚠ {err}</div>}
      <Button variant="primary" style={{ marginTop: space.md }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Create goal'}</Button>
    </Modal>
  )
}

export default function GoalsSection({ orgId, getToken, goals, onChanged }: { orgId: string; getToken: Getter; goals: GoalNode[] | null; onChanged: () => void }) {
  const [dlg, setDlg] = useState(false)
  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Goals</SectionLabel>
        <Button style={{ color: tk.accent }} onClick={() => setDlg(true)}>＋ Goal</Button>
      </div>
      <Card>
        {(goals ?? []).map(g => <NodeRow key={g.id} node={g} depth={0} />)}
        {goals && goals.length === 0 && <p style={sx.empty}>No goals yet — add the company’s top-level goal so every task traces to a “why”.</p>}
        {!goals && <p style={sx.loading}>Loading…</p>}
      </Card>
      {dlg && <GoalDialog orgId={orgId} getToken={getToken} goals={goals ?? []} onClose={() => setDlg(false)} onDone={() => { setDlg(false); onChanged() }} />}
    </div>
  )
}
