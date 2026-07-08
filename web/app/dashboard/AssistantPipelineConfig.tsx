'use client'
// Arturita J2 — the Config panel for the free-first pipeline (LLM/STT/TTS).
// Reads/saves the three ordered fallback chains via GET/PUT /arturita/pipeline.
// Each layer: primary first, then fallbacks; per-entry mode (🔒 local / ☁
// provider), reorder, remove, add-from-presets, reset-to-free-first. Colorblind-
// safe: mode is icon+label (never color-only); destructive "Remove" is a red
// outline, never a lone red CTA. Edit logic is pure in ./assistantConfig.logic.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from './tokens'
import { Button, Card, Select, SectionLabel } from './ui'
import {
  PRESETS, entryLabel, entryKey, moveEntry, removeAt, appendEntry, toggleMode,
  type Entry, type PipelineLayer,
} from './assistantConfig.logic'

type Getter = () => Promise<string | null>
type Chains = { llm: Entry[]; stt: Entry[]; tts: Entry[] }
type PipelineResp = Chains & { defaults: Chains }

const LAYERS: { key: PipelineLayer; label: string; hint: string }[] = [
  { key: 'llm', label: '🧠 Language model', hint: 'Local Ollama first; free-tier cloud + your paid keys as fallbacks.' },
  { key: 'stt', label: '🎧 Speech-to-text', hint: 'Self-hosted Whisper first; browser Web Speech as the zero-install fallback.' },
  { key: 'tts', label: '🔊 Text-to-speech', hint: 'Self-hosted Piper/Chatterbox first; browser voice + hosted Chatterbox as fallbacks.' },
]

export default function AssistantPipelineConfig({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [open, setOpen] = useState(false)
  const [chains, setChains] = useState<Chains | null>(null)
  const [defaults, setDefaults] = useState<Chains | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api<PipelineResp>(`/api/orgs/${orgId}/arturita/pipeline`, { token: await getToken() })
      setChains({ llm: r.llm, stt: r.stt, tts: r.tts })
      setDefaults(r.defaults)
      setDirty(false)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load pipeline config') }
  }, [orgId, getToken])

  useEffect(() => { if (open && !chains) load() }, [open, chains, load])

  const edit = (layer: PipelineLayer, next: Entry[]) => { setChains(c => c ? { ...c, [layer]: next } : c); setDirty(true); setMsg(null) }

  const save = async () => {
    if (!chains) return
    setBusy(true); setErr(null); setMsg(null)
    try {
      await api(`/api/orgs/${orgId}/arturita/pipeline`, {
        token: await getToken(), method: 'PUT',
        body: JSON.stringify({ arturita_llm_chain: chains.llm, arturita_stt_chain: chains.stt, arturita_tts_chain: chains.tts }),
      })
      setDirty(false); setMsg('Saved — Arturita will use these on the next turn.')
    } catch (e: any) { setErr(e?.message ?? 'Save failed') }
    finally { setBusy(false) }
  }

  const resetDefaults = () => { if (defaults) { setChains({ ...defaults }); setDirty(true); setMsg(null) } }

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: space.sm, background: 'transparent', border: 'none', cursor: 'pointer', color: tk.text, fontSize: text.md.fontSize, fontWeight: 700, padding: 0, textAlign: 'left' }}>
        <span style={{ color: tk.muted }}>{open ? '▾' : '▸'}</span>
        ⚙ Pipeline &amp; voice — free-first, with fallbacks
        <span style={{ flex: 1 }} />
        {dirty && <span style={{ fontSize: text.xs.fontSize, color: tk.amber }}>● unsaved</span>}
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg, marginTop: space.xs }}>
          {!chains && !err && <p style={{ color: tk.muted, fontSize: text.sm.fontSize }}>Loading…</p>}
          {chains && LAYERS.map(({ key, label, hint }) => (
            <LayerEditor key={key} layer={key} label={label} hint={hint} entries={chains[key]} onChange={next => edit(key, next)} />
          ))}
          {(msg || err) && <div style={err ? errBox : okBox}>{err ? `⚠ ${err}` : `✓ ${msg}`}</div>}
          {chains && (
            <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
              <Button variant="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save pipeline'}</Button>
              <Button onClick={resetDefaults} style={{ color: tk.accent }}>↺ Reset to free-first defaults</Button>
              <Button onClick={load} disabled={busy} style={{ color: tk.muted }}>Discard changes</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function LayerEditor({ layer, label, hint, entries, onChange }: { layer: PipelineLayer; label: string; hint: string; entries: Entry[]; onChange: (n: Entry[]) => void }) {
  const [addIdx, setAddIdx] = useState('')
  const presets = PRESETS[layer]
  const add = () => { const i = Number(addIdx); if (Number.isInteger(i) && presets[i]) { onChange(appendEntry(layer, entries, presets[i])); setAddIdx('') } }
  return (
    <div>
      <SectionLabel style={{ marginBottom: 2 }}>{label}</SectionLabel>
      <p style={{ ...hintStyle }}>{hint}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, marginTop: space.xs }}>
        {entries.map((e, i) => (
          <div key={entryKey(layer, e) + i} style={rowStyle}>
            <span style={{ ...pill, background: 'var(--s2)', color: tk.muted }}>{i === 0 ? 'primary' : `#${i + 1}`}</span>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entryLabel(layer, e)}</span>
            <button onClick={() => onChange(entries.map((x, xi) => xi === i ? toggleMode(x) : x))}
              title="toggle local / provider (privacy: local never leaves the device)"
              style={{ ...pill, cursor: 'pointer', border: `1px solid var(--line-strong)`, background: 'transparent', color: e.mode === 'local' ? tk.accent : tk.muted }}>
              {e.mode === 'local' ? '🔒 local' : '☁ provider'}
            </button>
            <button onClick={() => onChange(moveEntry(entries, i, -1))} disabled={i === 0} aria-label="move up" style={iconBtn(i === 0)}>▲</button>
            <button onClick={() => onChange(moveEntry(entries, i, 1))} disabled={i === entries.length - 1} aria-label="move down" style={iconBtn(i === entries.length - 1)}>▼</button>
            <button onClick={() => onChange(removeAt(entries, i))} aria-label="remove" title="Remove"
              style={{ ...iconBtn(false), border: '1px solid var(--danger-line)', color: tk.red }}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: space.sm, marginTop: space.sm }}>
        <Select value={addIdx} onChange={e => setAddIdx(e.target.value)} aria-label={`Add ${layer} option`} style={{ flex: 1, maxWidth: 320 }}>
          <option value="">＋ Add a fallback…</option>
          {presets.map((p, i) => <option key={i} value={i}>{entryLabel(layer, p)} {p.mode === 'local' ? '(local)' : '(cloud)'}</option>)}
        </Select>
        <Button onClick={add} disabled={addIdx === ''} style={{ color: tk.accent }}>Add</Button>
      </div>
    </div>
  )
}

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: space.sm, padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, background: tk.surface, fontSize: text.sm.fontSize }
const pill: React.CSSProperties = { fontSize: text.xs.fontSize, fontWeight: 700, borderRadius: tk.r.pill, padding: '1px 8px', whiteSpace: 'nowrap' }
const hintStyle: React.CSSProperties = { fontSize: text.xs.fontSize, color: tk.muted, margin: 0 }
const errBox: React.CSSProperties = { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: `${space.sm}px ${space.md}px`, fontSize: text.sm.fontSize }
const okBox: React.CSSProperties = { background: 'var(--ok-bg)', border: '1px solid var(--ok)', color: tk.green, borderRadius: tk.r.md, padding: `${space.sm}px ${space.md}px`, fontSize: text.sm.fontSize }
function iconBtn(disabled: boolean): React.CSSProperties {
  return { background: 'transparent', border: '1px solid var(--line-strong)', color: disabled ? tk.muted : tk.textDim, borderRadius: 6, padding: '1px 6px', fontSize: text.xs.fontSize, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 }
}
