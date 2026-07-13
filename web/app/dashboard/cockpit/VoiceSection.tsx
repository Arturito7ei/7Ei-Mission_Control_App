'use client'
// Arturita B2 — Cockpit voice panel. Push-to-talk (default) or "Arturita"
// wake-word (opt-in, S5). Captures speech in-browser (Web Speech API), routes
// the transcript through the existing /arturita/voice flow (ask vs execute —
// B3), and voices the reply back via the configured mode (provider TTS bytes,
// else local browser SpeechSynthesis — B1 local|provider). Approval-aware: a
// destructive command is flagged as pausing at the A2 gate, and any live
// approvals render inline with the tri-state controls (approve / request
// changes / reject). Colorblind-safe: every state carries an icon + text +
// shape; red is never the lone CTA (DESIGN_SYSTEM v2).
//
// Decision logic is pure + unit-tested in ./voicePanel.logic (this file is the
// impure shell: capture, network, playback).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel, TextInput, Select } from '../ui'
import { EXT_PURPLE, sx, type Approval, type ApprovalDecision, type Getter } from './shared'
import {
  decideSubmit, pickPlayback, toFeedItem, WAKE_WORD,
  type FeedItem, type VoiceMode, type VoiceResponse,
} from './voicePanel.logic'
import { classifySttError } from '@/lib/talkDiagnostics'
import { detectBrave } from '@/lib/browserEnv'

type Props = {
  orgId: string
  getToken: Getter
  /** live pending approvals (same source InboxSection uses) — rendered inline */
  approvals?: Approval[]
  onDecide?: (id: string, decision: ApprovalDecision, note?: string) => void
}

export default function VoiceSection({ orgId, getToken, approvals = [], onDecide }: Props) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [mode, setMode] = useState<VoiceMode>('local')
  const [wakeWord, setWakeWord] = useState(false)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [revising, setRevising] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const recogRef = useRef<any>(null)
  const braveRef = useRef(false)
  const seqRef = useRef(0)
  const threadRef = useRef<string | null>(null)
  const wakeRef = useRef(wakeWord)
  const modeRef = useRef(mode)
  useEffect(() => { wakeRef.current = wakeWord }, [wakeWord])
  useEffect(() => { modeRef.current = mode }, [mode])
  // Detect Brave once so a built-in-STT failure can name it (Brave disables the
  // Google speech backend Web Speech relies on → a persistent `network` error).
  useEffect(() => { let ok = true; detectBrave().then(b => { if (ok) braveRef.current = b }); return () => { ok = false } }, [])

  // ── Send a command (from speech or the typed fallback) ─────────────────────
  const send = useCallback(async (command: string, confidence: number | null) => {
    setBusy(true); setErr(null)
    try {
      const resp = await api<VoiceResponse>(`/api/orgs/${orgId}/arturita/voice`, {
        token: await getToken(),
        method: 'POST',
        body: JSON.stringify({
          transcript: command,
          confidence,
          mode: modeRef.current,
          speak: true,
          existingThreadId: threadRef.current,
        }),
      })
      const item = toFeedItem({ command, resp, seq: ++seqRef.current })
      if (item.taskId) threadRef.current = item.taskId
      setFeed(f => [item, ...f].slice(0, 12))
      playReply(resp)
    } catch (e: any) {
      setErr(e?.message ?? 'Voice command failed')
    } finally {
      setBusy(false)
    }
  }, [orgId, getToken])

  // ── Speech capture (Web Speech API) ────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setSupported(false); return }
    setSupported(true)
    const r = new SR()
    r.continuous = true
    r.interimResults = true
    r.lang = 'en-US'
    r.onresult = (ev: any) => {
      let live = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]
        const alt = res[0]
        if (res.isFinal) {
          const decision = decideSubmit({ transcript: alt.transcript, wakeWordMode: wakeRef.current })
          if (decision.submit) send(decision.cleaned, typeof alt.confidence === 'number' ? alt.confidence : null)
        } else {
          live += alt.transcript
        }
      }
      setInterim(live)
    }
    r.onerror = (ev: any) => {
      const st = classifySttError(ev?.error, { brave: braveRef.current })
      if (!st.failed) return
      // Built-in STT unusable here (Brave/network) or blocked/no-mic — all map to
      // a specific, actionable line; typing the command below always works.
      if (st.unavailable) { r.__active = false; try { r.stop() } catch { /* noop */ }; setListening(false); setInterim('') }
      setErr(st.hint ? `${st.message} ${st.hint}` : st.message)
    }
    r.onend = () => {
      // Keep listening across natural pauses while the toggle is on.
      if (recogRef.current?.__active) { try { r.start() } catch { /* already starting */ } }
      else setListening(false)
    }
    recogRef.current = r
    return () => { try { r.__active = false; r.stop() } catch { /* noop */ } ; recogRef.current = null }
  }, [send])

  const toggleListen = () => {
    const r = recogRef.current
    if (!r) return
    setErr(null)
    if (listening) {
      r.__active = false
      try { r.stop() } catch { /* noop */ }
      setListening(false); setInterim('')
    } else {
      r.__active = true
      try { r.start(); setListening(true) } catch { /* start after prior stop settles */ }
    }
  }

  const playReply = (resp: VoiceResponse) => {
    const pb = pickPlayback(resp.reply)
    if (pb.kind === 'audio' && pb.audioSrc) {
      try { void new Audio(pb.audioSrc).play() } catch { /* autoplay may be blocked; text still shown */ }
    } else if (pb.kind === 'speech' && pb.text && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        const u = new SpeechSynthesisUtterance(pb.text)
        u.lang = 'en-US'
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(u)
      } catch { /* TTS unavailable; text still shown */ }
    }
  }

  const submitTyped = () => {
    const t = typed.trim()
    if (!t || busy) return
    // The typed box is an explicit command, so wake-word gating does not apply.
    setTyped('')
    send(t, 1)
  }

  const sendRevision = (id: string) => {
    const n = note.trim()
    if (!n || !onDecide) return
    onDecide(id, 'revision_requested', n)
    setRevising(null); setNote('')
  }

  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>🎙 Arturita voice</SectionLabel>
        {listening
          ? <span style={{ ...sx.tag, background: 'var(--accent-dim)', color: EXT_PURPLE }} role="status">● Listening…</span>
          : <span style={{ ...sx.tag, background: 'var(--s2)', color: tk.muted }}>○ Idle</span>}
      </div>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        {/* Controls row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
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

          <div style={{ flex: 1 }} />

          <label style={{ ...s.toggle, gap: space.sm }}>
            <span style={{ color: tk.muted, fontSize: text.xs.fontSize }}>Voice</span>
            <Select value={mode} onChange={e => setMode(e.target.value as VoiceMode)} aria-label="Voice privacy mode" style={{ width: 130 }}>
              <option value="local">🔒 Local</option>
              <option value="provider">☁ Provider</option>
            </Select>
          </label>
        </div>

        {/* Live transcript (aria-live so it's announced) */}
        <div aria-live="polite" style={s.transcript}>
          {interim
            ? <span style={{ color: tk.text }}>{interim}<span style={{ color: tk.muted }}> …</span></span>
            : <span style={{ color: tk.muted }}>
                {supported
                  ? (wakeWord ? `Listening for “${WAKE_WORD}, …”` : 'Tap “Push to talk”, then speak your command.')
                  : 'Speech capture isn’t available in this browser — type a command below.'}
              </span>}
        </div>

        {/* Typed fallback — always available (no-mic browsers, quiet rooms, a11y) */}
        <div style={{ display: 'flex', gap: space.sm }}>
          <TextInput
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitTyped() }}
            placeholder="…or type a command for Arturita"
            aria-label="Type a command for Arturita"
            style={{ flex: 1 }}
          />
          <Button variant="primary" disabled={busy || !typed.trim()} onClick={submitTyped}>{busy ? '…' : 'Send'}</Button>
        </div>

        {err && <div style={sx.err}>⚠ {err}</div>}
        <p style={sx.hint}>
          {mode === 'local'
            ? '🔒 Local mode keeps audio off third-party servers. Sensitive (wallet/secret) commands are always forced local.'
            : '☁ Provider mode uses the configured cloud voice (Chatterbox/NVIDIA) for spoken replies; it falls back to local text if unavailable.'}
        </p>

        {/* Inline approvals — tri-state, approval-aware (A2 gate) */}
        {approvals.length > 0 && onDecide && (
          <div style={{ borderTop: `1px solid ${tk.line}`, paddingTop: space.md, display: 'flex', flexDirection: 'column', gap: space.xs }}>
            <span style={{ fontSize: text.xs.fontSize, color: tk.muted, fontWeight: 600 }}>⛔ Awaiting your approval</span>
            {approvals.map(a => (
              <div key={a.id}>
                <div style={sx.row}>
                  <span style={{ ...sx.tag, background: 'var(--accent-dim)', color: EXT_PURPLE }}>Approval · {a.type}</span>
                  <div style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{a.summary}</div>
                  <Button style={{ color: tk.accent }} onClick={() => onDecide(a.id, 'approved')}>✓ Approve</Button>
                  <Button style={{ color: tk.accent }} onClick={() => { setRevising(r => r === a.id ? null : a.id); setNote('') }}>↩ Request changes</Button>
                  <Button style={{ color: tk.red }} onClick={() => onDecide(a.id, 'rejected')}>✕ Reject</Button>
                </div>
                {revising === a.id && (
                  <div style={{ ...sx.row, gap: space.md }}>
                    <TextInput autoFocus value={note} onChange={e => setNote(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') sendRevision(a.id); if (e.key === 'Escape') { setRevising(null); setNote('') } }}
                      placeholder="What needs to change?" style={{ flex: 1 }} />
                    <Button variant="primary" disabled={!note.trim()} onClick={() => sendRevision(a.id)}>Send</Button>
                    <Button style={{ color: tk.muted }} onClick={() => { setRevising(null); setNote('') }}>Cancel</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Action feed — what was heard, how it routed */}
        {feed.length > 0 && (
          <div style={{ borderTop: `1px solid ${tk.line}`, paddingTop: space.md, display: 'flex', flexDirection: 'column' }}>
            {feed.map(f => <FeedRow key={f.seq} item={f} />)}
          </div>
        )}
      </Card>
    </div>
  )
}

function FeedRow({ item }: { item: FeedItem }) {
  const badge = item.workMode === 'reprompt'
    ? { icon: '↺', label: 'Repeat', bg: 'var(--warn-bg)', fg: tk.amber }
    : item.workMode === 'ask'
      ? { icon: 'ℹ', label: 'Ask', bg: 'var(--info-bg)', fg: tk.blue }
      : { icon: '▸', label: 'Execute', bg: 'var(--accent-dim)', fg: EXT_PURPLE }
  return (
    <div style={{ ...sx.row, alignItems: 'flex-start' }}>
      <span style={{ ...sx.tag, background: badge.bg, color: badge.fg, marginTop: 2 }} title={badge.label} aria-label={badge.label}>
        {badge.icon} {badge.label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
          {item.isFollowUp && <span title="continues the same thread" style={{ color: tk.muted }}>↳ </span>}
          {item.command || <span style={{ color: tk.muted }}>(reprompt)</span>}
        </div>
        <div style={{ fontSize: text.xs.fontSize, color: tk.muted, marginTop: 1 }}>{item.ack}</div>
      </div>
      {item.needsApproval && (
        <span style={{ ...sx.tag, background: 'var(--danger-bg)', color: 'var(--danger-text)', marginTop: 2 }}
          title="pauses at the approval gate before anything irreversible">
          ⛔ Needs approval
        </span>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  toggle: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: text.sm.fontSize, color: tk.textDim, cursor: 'pointer', userSelect: 'none' },
  transcript: { minHeight: 40, padding: `${space.sm}px ${space.md}px`, borderRadius: tk.r.md, background: 'var(--s2)', border: `1px solid ${tk.line}`, fontSize: text.sm.fontSize, lineHeight: 1.5 },
}
