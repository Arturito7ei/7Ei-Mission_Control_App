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
import { Button, Card, Select, SectionLabel, TextInput } from './ui'
import {
  PRESETS, entryLabel, entryKey, moveEntry, removeAt, appendEntry, toggleMode,
  type Entry, type PipelineLayer, type LlmEntry,
} from './assistantConfig.logic'
import { probeOllama, DEFAULT_OLLAMA_URL } from '@/lib/ollama'
import { probeWhisper, isWhisperEngine, WHISPER_DEFAULT_URL } from '@/lib/whisper'
import { detectBrave, hasWebSpeechStt } from '@/lib/browserEnv'
import { runSelfTest, overallSeverity, pickSpeechVoice, type LegResult } from '@/lib/talkDiagnostics'

type Getter = () => Promise<string | null>
type Chains = { llm: Entry[]; stt: Entry[]; tts: Entry[] }
type PipelineResp = Chains & { defaults: Chains }

const LAYERS: { key: PipelineLayer; label: string; hint: string }[] = [
  { key: 'llm', label: '🧠 Language model', hint: 'Local Ollama first; free-tier cloud + your paid keys as fallbacks.' },
  { key: 'stt', label: '🎧 Speech-to-text', hint: 'Local Whisper first (free, on-device, works in Brave — run the arturita-stt bridge); browser Web Speech as the zero-install fallback; typing always works.' },
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

  // ── Talk-path self-test — probe each leg (backend / local Ollama / TTS / STT)
  // and shape the results via the pure `runSelfTest`. Colorblind-safe rows. ────
  const [testing, setTesting] = useState(false)
  const [selfTest, setSelfTest] = useState<LegResult[] | null>(null)
  const runTest = async () => {
    setTesting(true); setSelfTest(null)
    // 1. backend reachable? — a lightweight authed GET (this endpoint).
    let backendOk = false, backendDetail: string | null = null
    try { await api(`/api/orgs/${orgId}/arturita/pipeline`, { token: await getToken() }); backendOk = true }
    catch (e: any) { backendDetail = e?.message ?? 'unreachable' }
    // 2. cloud LLM actually reachable? — a REAL 1-token probe on the backend, so a
    // stored-but-invalid key (e.g. an expired Anthropic key) reads as unusable,
    // not a false ✓. null = couldn't run the probe (backend down / error).
    let cloudLlmUsable: boolean | null = null, cloudLlmDetail: string | null = null
    if (backendOk) {
      try {
        const s = await api<{ cloudUsable: boolean; detail?: string }>(`/api/orgs/${orgId}/arturita/llm-status`, { token: await getToken() })
        cloudLlmUsable = !!s.cloudUsable; cloudLlmDetail = s.detail ?? null
      } catch (e: any) { cloudLlmUsable = null; cloudLlmDetail = e?.message ?? null }
    }
    // 3. local Ollama reachable? (+ configured primary model)
    const primary = (chains?.llm ?? []).find((e): e is LlmEntry => 'provider' in e && (e as LlmEntry).provider === 'ollama' && (e as LlmEntry).mode === 'local')
    const ollamaModels = await probeOllama(DEFAULT_OLLAMA_URL)
    // 4/5. browser TTS + STT capabilities, + the free local Whisper bridge.
    const hasTts = typeof window !== 'undefined' && 'speechSynthesis' in window
    const voices = hasTts ? (window.speechSynthesis.getVoices() ?? []) : []
    const localVoice = !!pickSpeechVoice(voices as any, 'en-US')?.localService
    const hasStt = hasWebSpeechStt()
    const brave = await detectBrave()   // Brave disables built-in Web Speech STT
    // Probe the local whisper bridge only when the STT chain asks for it.
    const wantsWhisper = (chains?.stt ?? []).some(e => isWhisperEngine((e as any).engine))
    const whisperReachable = wantsWhisper ? await probeWhisper(WHISPER_DEFAULT_URL) : false
    setSelfTest(runSelfTest({
      backendOk, backendDetail,
      ollamaModels, ollamaPrimaryModel: primary ? (primary as LlmEntry).model : null,
      cloudLlmUsable, cloudLlmDetail,
      ttsSupported: hasTts, ttsLocalVoice: localVoice,
      sttSupported: hasStt, sttBlocked: brave, whisperReachable,
    }))
    setTesting(false)
  }

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
          {chains && (
            <CustomModelForm
              orgId={orgId} getToken={getToken} dirty={dirty}
              onAdded={(llm, note) => { setChains(c => c ? { ...c, llm } : c); setDirty(false); setMsg(note); setErr(null) }}
            />
          )}
          {/* ── Talk-path self-test ─────────────────────────────────────────── */}
          <div style={{ borderTop: `1px solid ${tk.line}`, paddingTop: space.md }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
              <SectionLabel style={{ margin: 0 }}>🩺 Talk-path self-test</SectionLabel>
              <span style={{ flex: 1 }} />
              <Button onClick={runTest} disabled={testing} style={{ color: tk.accent }}>{testing ? 'Testing…' : 'Run self-test'}</Button>
            </div>
            <p style={hintStyle}>Checks each leg you use to talk to Arturita — backend, local Ollama, spoken replies, and mic — and tells you exactly what to fix.</p>
            {selfTest && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs, marginTop: space.sm }}>
                {selfTest.map((r, i) => (
                  <div key={r.leg + i} style={{ ...rowStyle, alignItems: 'flex-start' }}>
                    <span style={{ ...pill, background: 'var(--s2)', color: r.severity === 'fail' ? tk.red : r.severity === 'warn' ? tk.amber : tk.green, minWidth: 24, textAlign: 'center' }}>{r.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{r.label}</div>
                      <div style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{r.detail}{r.hint ? <><br /><span style={{ color: tk.textDim }}>→ {r.hint}</span></> : null}</div>
                    </div>
                  </div>
                ))}
                <p style={{ ...hintStyle, marginTop: 2 }}>
                  {overallSeverity(selfTest) === 'ok' ? '✓ All legs healthy — voice + answers should work end-to-end.'
                    : overallSeverity(selfTest) === 'warn' ? '▲ Working, with optional legs degraded (Arturita still answers via the cloud chain + text).'
                    : '✕ A required leg is down — see the fix hint above.'}
                </p>
              </div>
            )}
          </div>

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

// ─── Custom operator-defined LLM ─────────────────────────────────────────────
// Add an arbitrary OpenAI-compatible (or keyless local base-URL) model instead of
// picking from the presets. Persists to the encrypted store + LLM chain via
// POST /arturita/custom-model; the key never leaves the form except over the API.
type Getter2 = () => Promise<string | null>
type AddResp = { ok: boolean; slug: string; entry: Entry; maskedKey: string | null; llm: Entry[] }
type TestResp = { ok: boolean; status: number | null; detail: string }

function CustomModelForm({ orgId, getToken, dirty, onAdded }: { orgId: string; getToken: Getter2; dirty: boolean; onAdded: (llm: Entry[], note: string) => void }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<'provider' | 'local'>('provider')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<TestResp | null>(null)
  const [formErr, setFormErr] = useState<string | null>(null)

  const canSubmit = model.trim() !== '' && baseUrl.trim() !== '' && !busy
  const body = () => ({ label: label.trim() || undefined, model: model.trim(), baseUrl: baseUrl.trim(), mode, apiKey: apiKey.trim() || undefined })

  const runTest = async () => {
    setBusy(true); setTestResult(null); setFormErr(null)
    try {
      const r = await api<TestResp>(`/api/orgs/${orgId}/arturita/custom-model/test`, {
        token: await getToken(), method: 'POST',
        body: JSON.stringify({ model: model.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined }),
      })
      setTestResult(r)
    } catch (e: any) { setFormErr(e?.message ?? 'Test failed') }
    finally { setBusy(false) }
  }

  const add = async () => {
    setBusy(true); setFormErr(null)
    try {
      const r = await api<AddResp>(`/api/orgs/${orgId}/arturita/custom-model`, { token: await getToken(), method: 'POST', body: JSON.stringify(body()) })
      onAdded(r.llm, `Added “${label.trim() || model.trim()}”${r.maskedKey ? ` (key ${r.maskedKey})` : ''} — it’s in the LLM chain (reorder above to change priority).`)
      setLabel(''); setBaseUrl(''); setModel(''); setApiKey(''); setTestResult(null); setOpen(false)
    } catch (e: any) { setFormErr(e?.message ?? 'Add failed') }
    finally { setBusy(false) }
  }

  return (
    <div style={{ border: `1px dashed ${tk.line}`, borderRadius: tk.r.md, padding: space.sm }}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: space.sm, background: 'transparent', border: 'none', cursor: 'pointer', color: tk.accent, fontSize: text.sm.fontSize, fontWeight: 700, padding: 0 }}>
        <span style={{ color: tk.muted }}>{open ? '▾' : '▸'}</span> ＋ Add a custom model (OpenAI-compatible or local base URL)
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm, marginTop: space.sm }}>
          {dirty && <div style={{ fontSize: text.xs.fontSize, color: tk.amber }}>▲ Save or discard your pipeline edits above first — adding a custom model persists immediately and reloads the saved chain.</div>}
          <label style={fieldLabel}>Display name
            <TextInput value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Together Llama 3.3" aria-label="Display name" />
          </label>
          <label style={fieldLabel}>Base URL <span style={{ color: tk.muted }}>(OpenAI-compatible endpoint)</span>
            <TextInput value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.together.xyz/v1" aria-label="Base URL" />
          </label>
          <label style={fieldLabel}>Model id
            <TextInput value={model} onChange={e => setModel(e.target.value)} placeholder="meta-llama/Llama-3.3-70B-Instruct-Turbo" aria-label="Model id" />
          </label>
          <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
            <label style={{ ...fieldLabel, flex: 1, minWidth: 180 }}>Type
              <Select value={mode} onChange={e => setMode(e.target.value as any)} aria-label="Model type">
                <option value="provider">☁ Provider (hosted — needs an API key)</option>
                <option value="local">🔒 Local base URL (no key — Ollama-style)</option>
              </Select>
            </label>
            <label style={{ ...fieldLabel, flex: 1, minWidth: 180 }}>API key <span style={{ color: tk.muted }}>{mode === 'local' ? '(not needed)' : '(stored encrypted)'}</span>
              <TextInput type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={mode === 'local' ? '—' : 'sk-…'} autoComplete="off" aria-label="API key" disabled={mode === 'local'} />
            </label>
          </div>
          {testResult && (
            <div style={{ fontSize: text.sm.fontSize, color: testResult.ok ? tk.green : tk.red }}>
              {testResult.ok ? '✓' : '✕'} {testResult.detail}{testResult.status ? ` (HTTP ${testResult.status})` : ''}
            </div>
          )}
          {formErr && <div style={errBox}>⚠ {formErr}</div>}
          <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
            <Button onClick={runTest} disabled={!canSubmit} style={{ color: tk.accent }}>{busy ? '…' : 'Test reachability'}</Button>
            <Button variant="primary" onClick={add} disabled={!canSubmit || dirty}>{busy ? 'Adding…' : 'Add to LLM chain'}</Button>
          </div>
          <p style={hintStyle}>The key is stored in the encrypted secret store — never committed, never logged. The model joins the LLM fallback chain and rides the F1 breaker like any built-in.</p>
        </div>
      )}
    </div>
  )
}

const fieldLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: text.xs.fontSize, color: tk.textDim, fontWeight: 600 }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: space.sm, padding: `${space.xs}px ${space.sm}px`, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, background: tk.surface, fontSize: text.sm.fontSize }
const pill: React.CSSProperties = { fontSize: text.xs.fontSize, fontWeight: 700, borderRadius: tk.r.pill, padding: '1px 8px', whiteSpace: 'nowrap' }
const hintStyle: React.CSSProperties = { fontSize: text.xs.fontSize, color: tk.muted, margin: 0 }
const errBox: React.CSSProperties = { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: `${space.sm}px ${space.md}px`, fontSize: text.sm.fontSize }
const okBox: React.CSSProperties = { background: 'var(--ok-bg)', border: '1px solid var(--ok)', color: tk.green, borderRadius: tk.r.md, padding: `${space.sm}px ${space.md}px`, fontSize: text.sm.fontSize }
function iconBtn(disabled: boolean): React.CSSProperties {
  return { background: 'transparent', border: '1px solid var(--line-strong)', color: disabled ? tk.muted : tk.textDim, borderRadius: 6, padding: '1px 6px', fontSize: text.xs.fontSize, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 }
}
