'use client'
// Arturita J1 — the "Jarvis" Assistant tab. A voice-first conversational surface
// with a Glassmorphism aesthetic (frosted hero + reactive orb) layered on the
// existing cockpit primitives.
//
// Behaviour (the key design point): by DEFAULT Arturita answers the operator
// DIRECTLY — a streamed conversational reply from the F1 fallback LLM chain
// (POST /arturita/converse, mode 'answer'). She only routes into the task/agent
// flow when the operator EXPLICITLY asks her to build/do/delegate, or when the
// intent is destructive — and that routing decision is surfaced on the message.
// Every real/dangerous action still flows through the A2 approval gate (it lands
// in the Inbox as a task).
//
// Impure shell only: Web Speech capture, network, TTS playback, and the orb.
// Decisions + shapes are pure in ./assistant.logic (unit-tested).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space, ui } from './tokens'
import { Button, Card, TextInput } from './ui'
import AssistantOrb from './AssistantOrb'
import AssistantPipelineConfig from './AssistantPipelineConfig'
import {
  resolveVoiceState, toConverseRequest, toArturitaMessage,
  revealStepFor, routingBadge, type Message, type ConverseResponse,
} from './assistant.logic'
import { decideSubmit, WAKE_WORD } from './cockpit/voicePanel.logic'
import { probeOllama, streamOllamaChat, DEFAULT_OLLAMA_URL, type ChatMsg } from '@/lib/ollama'
import { pickSpeechVoice, classifyTtsError, classifySttError, describeTalkError, NO_LLM_FIX_HINT } from '@/lib/talkDiagnostics'
import { detectBrave } from '@/lib/browserEnv'
import { probeWhisper, transcribeWithWhisper, pickRecorderMimeType, isWhisperEngine, WHISPER_DEFAULT_URL } from '@/lib/whisper'
import { resolveSttEngine, sttEngineLabel } from '@/lib/sttEngine'

type Getter = () => Promise<string | null>

// ── Placeholder logo ─────────────────────────────────────────────────────────
// The ONLY reference to the Arturita logo asset. Drop the real artwork at this
// path (web/public/arturita-logo.svg) — same filename — and it swaps in with no
// code change. See the banner comment inside that SVG for asset guidance.
const ARTURITA_LOGO_SRC = '/arturita-logo.svg'

let msgSeq = 0
const nextId = () => `m${Date.now()}-${++msgSeq}`

export default function AssistantPanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [typed, setTyped] = useState('')
  const [interim, setInterim] = useState('')
  const [supported, setSupported] = useState(false)
  // Built-in Web Speech STT feature-detects as present but can't actually work
  // here (Brave disables its Google STT backend → a persistent `network` error).
  // When that happens we stop steering the operator at the mic and point them at
  // the typed box / local Whisper instead.
  const [sttUnavailable, setSttUnavailable] = useState(false)
  // Free local Whisper voice input (browser → the arturita-stt bridge on
  // 127.0.0.1, same trust model as local Ollama). Resolved from the STT pipeline
  // chain + a reachability probe; when reachable it's the primary capture engine
  // and works even in Brave (where built-in Web Speech STT is blocked).
  const [sttChain, setSttChain] = useState<{ engine: string; mode?: string }[]>([])
  const [whisperReachable, setWhisperReachable] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [listening, setListening] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [delegate, setDelegate] = useState(false)      // explicit opt-in for the next turn
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [wakeWord, setWakeWord] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Non-fatal, colorblind-safe status (icon+label) for a leg that degraded but
  // didn't dead-end — a TTS voice failure, or a local-Ollama→cloud fallback.
  const [notice, setNotice] = useState<{ tone: 'warn' | 'info'; text: string } | null>(null)
  const [reveal, setReveal] = useState<{ id: string; shown: number } | null>(null)
  // J-prod: browser-direct local Ollama (free, private, real token streaming) —
  // resolved from the pipeline config + a reachability probe; null → use backend.
  const [localLlm, setLocalLlm] = useState<{ model: string; baseUrl: string } | null>(null)

  const recogRef = useRef<any>(null)
  const braveRef = useRef(false)
  const mediaRecRef = useRef<any>(null)
  const chunksRef = useRef<Blob[]>([])
  const whisperUrlRef = useRef(WHISPER_DEFAULT_URL)
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  const threadRef = useRef<string | null>(null)
  const wakeRef = useRef(wakeWord)
  const delegateRef = useRef(delegate)
  const voiceRef = useRef(voiceReplies)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { wakeRef.current = wakeWord }, [wakeWord])
  useEffect(() => { delegateRef.current = delegate }, [delegate])
  useEffect(() => { voiceRef.current = voiceReplies }, [voiceReplies])

  const voiceState = resolveVoiceState({ speaking, thinking, listening })

  // Detect Brave once (async) so a built-in-STT failure can name it specifically.
  useEffect(() => { let ok = true; detectBrave().then(b => { if (ok) braveRef.current = b }); return () => { ok = false } }, [])
  // Release the mic if we unmount mid-recording (MediaRecorder path).
  useEffect(() => () => { try { mediaRecRef.current?.stream?.getTracks?.().forEach((t: MediaStreamTrack) => t.stop()) } catch { /* noop */ } }, [])

  // Browser voices populate asynchronously (Chrome fires `voiceschanged` after
  // the list is ready). Cache them so `speak` can pick an on-device voice.
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const load = () => { voicesRef.current = window.speechSynthesis.getVoices() ?? [] }
    load()
    window.speechSynthesis.addEventListener?.('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load)
  }, [])

  // ── Speak a reply locally (browser TTS). Converse returns text; local speech
  // is the client-side voice. Never throws, never dead-ends: it prefers an
  // on-device voice (Chrome's cloud voices throw a `network` error offline), and
  // on failure it retries once with a forced-local voice, then surfaces a
  // specific, non-fatal status — the reply text is always already on screen. ──
  const speak = useCallback((body: string) => {
    if (!voiceRef.current || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const synth = window.speechSynthesis
    const run = (voice: SpeechSynthesisVoice | null, isRetry: boolean) => {
      try {
        const u = new SpeechSynthesisUtterance(body)
        u.lang = 'en-US'
        if (voice) u.voice = voice
        u.onstart = () => { setSpeaking(true); setNotice(n => (n?.tone === 'warn' ? null : n)) }
        u.onend = () => setSpeaking(false)
        u.onerror = (ev: any) => {
          setSpeaking(false)
          const st = classifyTtsError(ev?.error)
          if (!st.failed) return // benign (interrupted/canceled) — we cancel each turn
          // one automatic retry forcing an on-device voice on a network failure
          if (st.kind === 'network' && !isRetry) {
            const local = (voicesRef.current || []).find(v => (v as any).localService && v !== voice)
            if (local) { run(local, true); return }
          }
          setNotice({ tone: 'warn', text: st.hint ? `${st.message} ${st.hint}` : st.message! })
        }
        synth.cancel()
        synth.speak(u)
      } catch { /* TTS unavailable; text still shown */ }
    }
    const preferred = pickSpeechVoice(voicesRef.current as any, 'en-US')
    const match = preferred ? (voicesRef.current || []).find(v => v.name === preferred.name) ?? null : null
    run(match, false)
  }, [])

  // Resolve a browser-reachable local Ollama from the pipeline config (once).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cfg = await api<{ llm: Array<{ provider?: string; model?: string; mode?: string }> }>(`/api/orgs/${orgId}/arturita/pipeline`, { token: await getToken() })
        const primary = (cfg.llm ?? []).find(e => e.mode === 'local' && e.provider === 'ollama' && e.model)
        if (!primary?.model) return
        const models = await probeOllama(DEFAULT_OLLAMA_URL)
        if (cancelled || !models) return
        const base = String(primary.model).split(':')[0]
        if (models.some(m => m === primary.model || m.split(':')[0] === base)) setLocalLlm({ model: primary.model!, baseUrl: DEFAULT_OLLAMA_URL })
      } catch { /* no local Ollama reachable → backend chain handles it */ }
    })()
    return () => { cancelled = true }
  }, [orgId, getToken])

  // Resolve the STT engine from the pipeline config: if the chain wants a local
  // whisper engine, probe the browser-reachable bridge (127.0.0.1:8790).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cfg = await api<{ stt: Array<{ engine: string; mode?: string }> }>(`/api/orgs/${orgId}/arturita/pipeline`, { token: await getToken() })
        if (cancelled) return
        const chain = cfg.stt ?? []
        setSttChain(chain)
        if (chain.some(e => isWhisperEngine(e.engine))) {
          const ok = await probeWhisper(WHISPER_DEFAULT_URL)
          if (!cancelled) setWhisperReachable(ok)
        }
      } catch { /* backend down → engine falls back to web speech / typing */ }
    })()
    return () => { cancelled = true }
  }, [orgId, getToken])

  // Which capture engine push-to-talk uses right now (typing is always available).
  const sttEngine = resolveSttEngine({ sttChain, whisperReachable, webSpeechAvailable: supported && !sttUnavailable })

  // ── Send a turn to the conversational front door ─────────────────────────────
  const send = useCallback(async (bodyText: string, explicit: boolean) => {
    const message = bodyText.trim()
    if (!message || thinking) return
    setErr(null); setNotice(null)
    const userMsg: Message = { id: nextId(), role: 'user', text: message }
    setMessages(m => [...m, userMsg])
    setThinking(true)
    const reqHistory = [...messages, userMsg]
    const baseReq = toConverseRequest({ message, explicitDelegate: explicit, existingThreadId: threadRef.current, history: reqHistory })
    const post = async (body: object) => api<ConverseResponse>(`/api/orgs/${orgId}/arturita/converse`, { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
    // When the backend answered but no LLM was reachable (degraded/text_only),
    // surface the actionable fix (enable local Ollama, or add a free cloud key)
    // right under the transcript instead of leaving only a ⚠ badge on the bubble.
    const noticeIfDegraded = (r: ConverseResponse) => {
      if (r.degraded || r.reply?.provider === 'text_only') setNotice({ tone: 'warn', text: `No language model was reachable for that reply. ${NO_LLM_FIX_HINT} Open ⚙ Pipeline config below and “Run self-test” to check each leg.` })
    }
    try {
      const resp = await post({ ...baseReq, deferAnswer: !!localLlm })

      // Delegate → the office runs it as a task (gated at A2 if destructive).
      if (resp.mode === 'delegate') {
        const arturita = toArturitaMessage({ id: nextId(), resp })
        if (arturita.taskId) threadRef.current = arturita.taskId
        setThinking(false); setMessages(m => [...m, arturita]); setReveal({ id: arturita.id, shown: 0 }); setSpeaking(true)
        return
      }

      // Answer deferred to the client → stream tokens live from local Ollama.
      if (resp.deferred && resp.prompt && localLlm) {
        const id = nextId()
        setThinking(false)
        setMessages(m => [...m, { id, role: 'arturita', text: '', streaming: true, mode: 'answer', routing: resp.routing ?? null, via: `local · ${localLlm.model}` }])
        setSpeaking(true)
        try {
          const msgs = (resp.prompt.messages ?? []).filter(m => m.role !== 'system') as ChatMsg[]
          const full = await streamOllamaChat({
            baseUrl: localLlm.baseUrl, model: localLlm.model, system: resp.prompt.system ?? '', messages: msgs,
            onToken: t => setMessages(m => m.map(x => x.id === id ? { ...x, text: x.text + t } : x)),
          })
          setMessages(m => m.map(x => x.id === id ? { ...x, streaming: false } : x))
          if (full.trim()) speak(full); else setSpeaking(false)
          return
        } catch (localErr) {
          // local stream failed (Ollama down / CORS) → drop the bubble, use cloud,
          // and tell the operator which leg degraded + how to fix it (OLLAMA_ORIGINS).
          setMessages(m => m.filter(x => x.id !== id)); setLocalLlm(null)
          const d = describeTalkError(localErr, 'local-ollama')
          setNotice({ tone: 'info', text: `${d.message} ${d.hint ?? ''}`.trim() })
          const cloud = await post({ ...baseReq, deferAnswer: false })
          noticeIfDegraded(cloud)
          const arturita = toArturitaMessage({ id: nextId(), resp: cloud })
          setMessages(m => [...m, arturita]); setReveal({ id: arturita.id, shown: 0 }); setSpeaking(true)
          return
        }
      }

      // Plain cloud answer → client-side reveal.
      noticeIfDegraded(resp)
      const arturita = toArturitaMessage({ id: nextId(), resp })
      setThinking(false); setMessages(m => [...m, arturita]); setReveal({ id: arturita.id, shown: 0 }); setSpeaking(true)
    } catch (e: any) {
      setThinking(false)
      // Specific, actionable message per leg — never the raw "network error".
      const d = describeTalkError(e, 'backend')
      setErr(d.hint ? `${d.message} ${d.hint}` : d.message)
    } finally {
      setDelegate(false)   // opt-in is per-turn
    }
  }, [orgId, getToken, messages, thinking, localLlm, speak])

  // ── Streamed reveal (typewriter) — advances the active message's shown length.
  useEffect(() => {
    if (!reveal) return
    const msg = messages.find(m => m.id === reveal.id)
    if (!msg) { setReveal(null); return }
    const total = msg.text.length
    if (reveal.shown >= total) {
      // reveal complete → mark done, speak, drop the streaming flag
      setMessages(m => m.map(x => x.id === reveal.id ? { ...x, streaming: false } : x))
      setReveal(null)
      if (msg.text) speak(msg.text); else setSpeaking(false)
      return
    }
    const step = revealStepFor(total)
    const t = setTimeout(() => setReveal(r => r ? { ...r, shown: Math.min(total, r.shown + step) } : r), 28)
    return () => clearTimeout(t)
  }, [reveal, messages, speak])

  // keep the transcript pinned to the newest message
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, reveal])

  // ── Speech capture (Web Speech API) — same gate as the B2 voice panel ────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setSupported(false); return }
    setSupported(true)
    const r = new SR()
    r.continuous = true; r.interimResults = true; r.lang = 'en-US'
    r.onresult = (ev: any) => {
      let live = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]; const alt = res[0]
        if (res.isFinal) {
          const d = decideSubmit({ transcript: alt.transcript, wakeWordMode: wakeRef.current })
          if (d.submit) send(d.cleaned, delegateRef.current)
        } else live += alt.transcript
      }
      setInterim(live)
    }
    r.onerror = (ev: any) => {
      const st = classifySttError(ev?.error, { brave: braveRef.current })
      if (!st.failed) return
      // `network` = built-in STT can't reach its backend (Brave disables it).
      // Non-fatal: stop listening, mark it unavailable, and steer to typing /
      // Whisper via the colorblind-safe notice (icon+label) — never a bare error.
      if (st.unavailable) {
        setSttUnavailable(true)
        recogRef.current && (recogRef.current.__active = false)
        try { r.stop() } catch { /* noop */ }
        setListening(false); setInterim('')
        setNotice({ tone: 'warn', text: st.hint ? `${st.message} ${st.hint}` : st.message! })
      } else {
        // permission / no-mic / unknown — actionable, typed input still works.
        setErr(st.hint ? `${st.message} ${st.hint}` : st.message)
      }
    }
    r.onend = () => { if (recogRef.current?.__active) { try { r.start() } catch { /* restarting */ } } else setListening(false) }
    recogRef.current = r
    return () => { try { r.__active = false; r.stop() } catch { /* noop */ }; recogRef.current = null }
  }, [send])

  // ── Local Whisper capture (free, on-device; works in Brave) ──────────────────
  // Push-to-talk records mic audio with MediaRecorder; on stop the blob is POSTed
  // to the local whisper bridge and the transcript feeds the same converse flow.
  const startWhisperCapture = useCallback(async () => {
    setErr(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickRecorderMimeType(m => (window as any).MediaRecorder?.isTypeSupported?.(m) ?? false)
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' })
        chunksRef.current = []
        setListening(false)
        if (!blob.size) return
        setTranscribing(true)
        try {
          const text = (await transcribeWithWhisper({ baseUrl: whisperUrlRef.current, blob, language: 'en' })).trim()
          if (text) send(text, delegateRef.current)
          else setNotice({ tone: 'info', text: 'Didn’t catch that — try again, or type your message below.' })
        } catch {
          // bridge went away → drop to typing and steer the operator to restart it.
          setWhisperReachable(false)
          setNotice({ tone: 'warn', text: 'Local Whisper couldn’t transcribe that — is the arturita-stt bridge running? Type below meanwhile.' })
        } finally { setTranscribing(false) }
      }
      mediaRecRef.current = rec
      rec.start()
      setListening(true)
    } catch {
      setErr('Microphone access is blocked or no mic was found — allow mic access, or type your message below.')
      setListening(false)
    }
  }, [send])

  const toggleListen = () => {
    // Whisper path: MediaRecorder start/stop (transcription happens on stop).
    if (sttEngine === 'whisper') {
      if (transcribing) return
      if (listening) { try { mediaRecRef.current?.stop() } catch { /* noop */ } }
      else startWhisperCapture()
      return
    }
    // Web Speech path (browsers where it works).
    const r = recogRef.current
    if (!r) return
    setErr(null)
    if (listening) { r.__active = false; try { r.stop() } catch {}; setListening(false); setInterim('') }
    else { r.__active = true; try { r.start(); setListening(true) } catch {} }
  }

  const submitTyped = () => { const t = typed.trim(); if (!t || thinking) return; setTyped(''); send(t, delegate) }

  return (
    <div style={{ ...ui.page, maxWidth: 920, gap: space.xl }}>
      {/* ── Glass hero: orb + identity ─────────────────────────────────────── */}
      <div className="mc-hero" style={{ padding: `${space.xxl}px ${space.xl}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.lg }}>
        <AssistantOrb state={voiceState} logoSrc={ARTURITA_LOGO_SRC} />
        <div style={{ textAlign: 'center' }}>
          {/* The surface is the Command Center (it matches the nav label); the
              assistant you talk to in it is still Arturita. */}
          <h1 style={{ ...ui.h1, justifyContent: 'center', fontSize: 24 }}>Command Center</h1>
          <p style={{ ...ui.hint, margin: `${space.xs}px 0 0` }}>
            Arturita, your voice-first chief of staff. She answers directly — and only spins up the office when you ask her to.
          </p>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Button
            variant={listening ? 'default' : 'primary'}
            disabled={sttEngine === 'none' || transcribing}
            aria-pressed={listening}
            aria-busy={transcribing}
            onClick={toggleListen}
            style={listening ? { borderColor: 'var(--accent-line)', color: tk.accent } : undefined}
          >
            {transcribing ? '◐ Transcribing…' : listening ? '■ Stop' : '🎙 Push to talk'}
          </Button>
          <label style={s.toggle}>
            <input type="checkbox" checked={wakeWord} onChange={e => setWakeWord(e.target.checked)} />
            <span>Wake word <b>“{WAKE_WORD}”</b></span>
          </label>
          <label style={s.toggle}>
            <input type="checkbox" checked={voiceReplies} onChange={e => setVoiceReplies(e.target.checked)} />
            <span>🔊 Spoken replies</span>
          </label>
        </div>
        {/* Active capture engine — colorblind-safe (icon+label). Typing always works. */}
        {sttEngine === 'none'
          ? <p style={sxHint}>🎙 Voice input isn’t available in this browser{braveRef.current ? ' (Brave blocks built-in speech recognition)' : ''} — type below, or start the free local Whisper bridge (see ⚙ Pipeline config → self-test).</p>
          : <p style={sxHint}>{sttEngineLabel(sttEngine)}{sttEngine === 'web_speech' && braveRef.current ? ' — may be blocked in Brave; start local Whisper for reliable voice.' : ''}</p>}
        <p style={sxHint}>
          {localLlm
            ? <>🔒 Running on your local <b>{localLlm.model}</b> (Ollama) — free &amp; on-device.</>
            : <>☁ Using the cloud fallback chain. <span title="Run Ollama with OLLAMA_ORIGINS set to this app's origin to go fully local & free.">Local Ollama not detected.</span></>}
        </p>
      </div>

      {/* ── Conversation ───────────────────────────────────────────────────── */}
      <div ref={scrollRef} style={{ display: 'flex', flexDirection: 'column', gap: space.md, maxHeight: 460, overflowY: 'auto', paddingRight: space.xs }}>
        {messages.length === 0 && !thinking && (
          <Card style={{ textAlign: 'center', color: tk.muted }}>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              Ask me anything — “what’s the fleet doing?”, “summarise today”. I’ll answer here.<br />
              Say <b>“build …”</b>, <b>“delegate …”</b>, or flip <b>Delegate to the office</b> and I’ll put it on the board (with approval for anything irreversible).
            </div>
          </Card>
        )}
        {messages.map(m => {
          const shown = reveal?.id === m.id ? m.text.slice(0, reveal.shown) : m.text
          return m.role === 'user'
            ? <UserBubble key={m.id} text={m.text} />
            : <ArturitaBubble key={m.id} msg={m} shown={shown} />
        })}
        {thinking && <ArturitaThinking />}
      </div>

      {err && <div style={ui.err}>⚠ {err}</div>}
      {notice && (
        <div role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: space.xs,
          background: notice.tone === 'warn' ? 'var(--warn-bg)' : 'var(--info-bg)',
          border: `1px solid ${notice.tone === 'warn' ? 'var(--line-strong)' : 'var(--accent-line)'}`,
          color: notice.tone === 'warn' ? tk.amber : tk.blue,
          borderRadius: tk.r.md, padding: `${space.xs}px ${space.md}px`, fontSize: text.sm.fontSize,
        }}>
          <span aria-hidden>{notice.tone === 'warn' ? '▲' : 'ⓘ'}</span>
          <span style={{ color: tk.textDim }}>{notice.text}</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setNotice(null)} aria-label="Dismiss" style={{ background: 'transparent', border: 'none', color: tk.muted, cursor: 'pointer', padding: 0, fontSize: text.sm.fontSize }}>✕</button>
        </div>
      )}

      {/* ── Composer ───────────────────────────────────────────────────────── */}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
        <div aria-live="polite" style={s.interim}>
          {interim
            ? <span style={{ color: tk.text }}>{interim}<span style={{ color: tk.muted }}> …</span></span>
            : <span style={{ color: tk.muted }}>{listening ? (wakeWord ? `Listening for “${WAKE_WORD}, …”` : 'Listening — speak your message.') : 'Type a message, or push to talk.'}</span>}
        </div>
        <div style={{ display: 'flex', gap: space.sm }}>
          <TextInput
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitTyped() }}
            placeholder="Message Arturita…"
            aria-label="Message Arturita"
            style={{ flex: 1 }}
          />
          <Button variant="primary" disabled={thinking || !typed.trim()} onClick={submitTyped}>{thinking ? '…' : 'Send'}</Button>
        </div>
        <label style={{ ...s.toggle, alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={delegate} onChange={e => setDelegate(e.target.checked)} />
          <span>▸ Delegate this to the office <span style={{ color: tk.muted }}>(instead of a direct answer)</span></span>
        </label>
      </Card>

      {/* ── Free-first pipeline config (LLM/STT/TTS chains, switchable) ─────── */}
      <AssistantPipelineConfig orgId={orgId} getToken={getToken} />
    </div>
  )
}

// ─── Bubbles ─────────────────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--accent-dim)', border: `1px solid var(--accent-line)`, borderRadius: tk.r.lg, padding: `${space.sm}px ${space.lg}px` }}>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: tk.text, whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  )
}

function ArturitaBubble({ msg, shown }: { msg: Message; shown: string }) {
  const badge = routingBadge(msg)
  const badgeStyle = badge.tone === 'approval'
    ? { bg: 'var(--danger-bg)', fg: 'var(--danger-text)' }
    : badge.tone === 'delegate'
      ? { bg: 'var(--accent-dim)', fg: 'var(--purple-1)' }
      : { bg: 'var(--info-bg)', fg: 'var(--info)' }
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '86%', background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, padding: `${space.md}px ${space.lg}px`, display: 'flex', flexDirection: 'column', gap: space.xs }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15 }}>🌸</span>
        <span style={{ ...tagStyle, background: badgeStyle.bg, color: badgeStyle.fg }}>{badge.icon} {badge.label}</span>
        {msg.via && <span style={{ ...tagStyle, background: 'var(--s2)', color: tk.muted }} title="which model produced this reply">{msg.via.startsWith('local') ? '🔒 ' : '☁ '}{msg.via}</span>}
        {msg.degraded && <span style={{ ...tagStyle, background: 'var(--warn-bg)', color: tk.amber }}>⚠ Degraded</span>}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: tk.text, whiteSpace: 'pre-wrap' }}>
        {shown}{msg.streaming && <span style={{ color: tk.muted }}>▍</span>}
      </div>
      {msg.mode === 'delegate' && msg.routing && (
        <div style={{ fontSize: text.xs.fontSize, color: tk.muted, borderTop: `1px solid ${tk.line}`, paddingTop: space.xs, marginTop: space.xxs }}>
          {msg.routing.reason}
          {msg.taskId && <span> · <span style={{ color: tk.accent }}>opened a task</span> — track it in the Inbox / Task board.</span>}
        </div>
      )}
    </div>
  )
}

function ArturitaThinking() {
  return (
    <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: space.sm, color: tk.muted, fontSize: text.sm.fontSize, padding: `${space.xs}px ${space.sm}px` }}>
      <span style={{ fontSize: 15 }}>🌸</span>
      <span style={{ color: 'var(--info)' }}>◐</span> Thinking…
    </div>
  )
}

const tagStyle: React.CSSProperties = { fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700, borderRadius: tk.r.pill, padding: '1px 8px', whiteSpace: 'nowrap' }
const sxHint: React.CSSProperties = { fontSize: text.xs.fontSize, color: tk.muted, margin: 0 }

const s: Record<string, React.CSSProperties> = {
  toggle: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: text.sm.fontSize, color: tk.textDim, cursor: 'pointer', userSelect: 'none' },
  interim: { minHeight: 20, fontSize: text.sm.fontSize, lineHeight: 1.5 },
}
