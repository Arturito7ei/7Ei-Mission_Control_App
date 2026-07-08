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
import {
  resolveVoiceState, toConverseRequest, toArturitaMessage,
  revealStepFor, routingBadge, type Message, type ConverseResponse,
} from './assistant.logic'
import { decideSubmit, WAKE_WORD } from './cockpit/voicePanel.logic'

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
  const [listening, setListening] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [delegate, setDelegate] = useState(false)      // explicit opt-in for the next turn
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [wakeWord, setWakeWord] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ id: string; shown: number } | null>(null)

  const recogRef = useRef<any>(null)
  const threadRef = useRef<string | null>(null)
  const wakeRef = useRef(wakeWord)
  const delegateRef = useRef(delegate)
  const voiceRef = useRef(voiceReplies)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { wakeRef.current = wakeWord }, [wakeWord])
  useEffect(() => { delegateRef.current = delegate }, [delegate])
  useEffect(() => { voiceRef.current = voiceReplies }, [voiceReplies])

  const voiceState = resolveVoiceState({ speaking, thinking, listening })

  // ── Speak a reply locally (browser TTS). Converse returns text; local speech
  // is the client-side voice. Never throws. ────────────────────────────────────
  const speak = useCallback((body: string) => {
    if (!voiceRef.current || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      const u = new SpeechSynthesisUtterance(body)
      u.lang = 'en-US'
      u.onstart = () => setSpeaking(true)
      u.onend = () => setSpeaking(false)
      u.onerror = () => setSpeaking(false)
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    } catch { /* TTS unavailable; text still shown */ }
  }, [])

  // ── Send a turn to the conversational front door ─────────────────────────────
  const send = useCallback(async (bodyText: string, explicit: boolean) => {
    const message = bodyText.trim()
    if (!message || thinking) return
    setErr(null)
    const userMsg: Message = { id: nextId(), role: 'user', text: message }
    setMessages(m => [...m, userMsg])
    setThinking(true)
    try {
      const reqHistory = [...messages, userMsg]
      const resp = await api<ConverseResponse>(`/api/orgs/${orgId}/arturita/converse`, {
        token: await getToken(),
        method: 'POST',
        body: JSON.stringify(toConverseRequest({ message, explicitDelegate: explicit, existingThreadId: threadRef.current, history: reqHistory })),
      })
      const arturita = toArturitaMessage({ id: nextId(), resp })
      if (arturita.taskId) threadRef.current = arturita.taskId
      setThinking(false)
      setMessages(m => [...m, arturita])
      setReveal({ id: arturita.id, shown: 0 })   // begin the streamed reveal
      setSpeaking(true)
    } catch (e: any) {
      setThinking(false)
      setErr(e?.message ?? 'Arturita is unreachable right now.')
    } finally {
      setDelegate(false)   // opt-in is per-turn
    }
  }, [orgId, getToken, messages, thinking])

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
      if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') setErr('Microphone permission denied — allow mic access or type below.')
      else if (ev?.error && ev.error !== 'no-speech' && ev.error !== 'aborted') setErr(`Speech error: ${ev.error}`)
    }
    r.onend = () => { if (recogRef.current?.__active) { try { r.start() } catch { /* restarting */ } } else setListening(false) }
    recogRef.current = r
    return () => { try { r.__active = false; r.stop() } catch { /* noop */ }; recogRef.current = null }
  }, [send])

  const toggleListen = () => {
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
          <h1 style={{ ...ui.h1, justifyContent: 'center', fontSize: 24 }}>Arturita</h1>
          <p style={{ ...ui.hint, margin: `${space.xs}px 0 0` }}>
            Your voice-first chief of staff. She answers directly — and only spins up the office when you ask her to.
          </p>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Button
            variant={listening ? 'default' : 'primary'}
            disabled={!supported}
            aria-pressed={listening}
            onClick={toggleListen}
            style={listening ? { borderColor: 'var(--accent-line)', color: tk.accent } : undefined}
          >
            {listening ? '■ Stop' : '🎙 Push to talk'}
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
        {!supported && <p style={sxHint}>Speech capture isn’t available in this browser — type below.</p>}
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
