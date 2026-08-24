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
import { tk, text, space, ui, density } from './tokens'
import { Button, Card, TextInput } from './ui'
import Reactor from './Reactor'
import AssistantPipelineConfig from './AssistantPipelineConfig'
import {
  resolveVoiceState, toConverseRequest, toArturitaMessage, persistedTurnsToMessages,
  revealStepFor, routingBadge, type Message, type ConverseResponse,
  rejectAttachment, attachmentChipLabel, canSendTurn, ATTACH_ACCEPT,
  rejectImage, imageChipLabel, imageMediaType, IMAGE_ACCEPT,
  ARTURITA_CHOICE, type AttachedDoc, type AttachedImage, type AgentIdentity, toWireAgentId,
  resolveJiraProjectSelection, jiraProjectLabel, type JiraProjectOption,
} from './assistant.logic'
import { AgentAvatar } from './agent/shared'
import { provenanceChip, reactorChips } from './reactor.logic'
import { decideSubmit, WAKE_WORD } from './cockpit/voicePanel.logic'
import { probeOllama, streamOllamaChat, DEFAULT_OLLAMA_URL, type ChatMsg } from '@/lib/ollama'
import { pickSpeechVoice, classifyTtsError, classifySttError, describeTalkError, NO_LLM_FIX_HINT } from '@/lib/talkDiagnostics'
import { detectBrave } from '@/lib/browserEnv'
import { probeWhisper, transcribeWithWhisper, pickRecorderMimeType, isWhisperEngine, WHISPER_DEFAULT_URL } from '@/lib/whisper'
import { resolveSttEngine, sttEngineLabel } from '@/lib/sttEngine'

type Getter = () => Promise<string | null>

/** GC-1 — the roster row the "To:" picker needs. A subset of the agents endpoint. */
type RosterAgent = {
  id: string; name: string; role?: string | null
  avatarEmoji?: string | null; avatarUrl?: string | null
  agentType?: string | null; status?: string | null
}

// The 7Ei honeycomb mark is now rendered INLINE at the reactor's glass core
// (see Reactor.tsx) so it can carry the reactor's glow and scale crisply; the
// static /arturita-logo.svg asset is no longer referenced by this panel.

let msgSeq = 0
const nextId = () => `m${Date.now()}-${++msgSeq}`

/**
 * MOB-7b — read a picked image to RAW base64 (no `data:` prefix), which is what
 * the /converse `image.data` contract takes.
 *
 * FileReader gives a data URI, so the prefix is stripped here — deliberately at
 * the one place the image enters the app, rather than carried along and stripped
 * somewhere later. The backend re-derives the media type from the `mediaType`
 * field, not from the URI, so the prefix would be dead weight on the wire.
 */
function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.onload = () => {
      const url = String(r.result ?? '')
      const comma = url.indexOf(',')
      if (comma < 0) return reject(new Error('unexpected reader output'))
      resolve(url.slice(comma + 1))
    }
    r.readAsDataURL(file)
  })
}

export default function AssistantPanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [typed, setTyped] = useState('')
  // CC-ATT — the document attached to the NEXT turn (one at a time). Its text is
  // extracted server-side on pick, so pressing Send is never blocked on a parse.
  const [attachment, setAttachment] = useState<AttachedDoc | null>(null)
  const [attaching, setAttaching] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // MOB-7b — the photo attached to the NEXT turn. Independent of `attachment`:
  // a photo has no text to extract, so it is read to base64 here and rides the
  // /converse call itself, reaching the model as an image block. The two can
  // ride the same turn ("does this screenshot match the spec?").
  const [image, setImage] = useState<AttachedImage | null>(null)
  const [reading, setReading] = useState(false)
  const photoRef = useRef<HTMLInputElement | null>(null)
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
  // J7 — the reactor is the PRINCIPAL view; the transcript + pipeline config open
  // behind this toggle (auto-opens on the first turn so replies are never hidden).
  const [showConvo, setShowConvo] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Non-fatal, colorblind-safe status (icon+label) for a leg that degraded but
  // didn't dead-end — a TTS voice failure, or a local-Ollama→cloud fallback.
  const [notice, setNotice] = useState<{ tone: 'warn' | 'info'; text: string } | null>(null)
  const [reveal, setReveal] = useState<{ id: string; shown: number } | null>(null)
  // J-prod: browser-direct local Ollama (free, private, real token streaming) —
  // resolved from the pipeline config + a reachability probe; null → use backend.
  const [localLlm, setLocalLlm] = useState<{ model: string; baseUrl: string } | null>(null)
  /** S3-B — hosted backend can answer via Fly Ollama when browser-local is absent. */
  const [hostedLlm, setHostedLlm] = useState<{ model: string } | null>(null)
  // GC-1 — WHO the operator is talking to. Defaults to the Arturita sentinel, so the
  // panel renders a correct, honest recipient before the roster has even loaded and
  // never sends a guessed id.
  const [recipient, setRecipient] = useState<string>(ARTURITA_CHOICE)
  const [roster, setRoster] = useState<RosterAgent[]>([])
  // GC-3 — Jira project context for Command Center (org-scoped, persisted server-side).
  const [jiraProjects, setJiraProjects] = useState<JiraProjectOption[]>([])
  const [jiraConnected, setJiraConnected] = useState(false)
  const [jiraDefaultKey, setJiraDefaultKey] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState('')
  const [jiraProjectHint, setJiraProjectHint] = useState<string | null>(null)

  // GC-1 — the recipient as an identity to RENDER (avatar + name). Resolved from the
  // roster; falls back to Arturita, which is also what an id that has vanished from the
  // roster resolves to — the bar must never show a blank or a raw uuid.
  const activeRecipient: AgentIdentity = recipient === ARTURITA_CHOICE
    ? { id: ARTURITA_CHOICE, name: 'Arturita', avatarEmoji: '🌸', role: 'Chief of Staff' }
    : (() => {
        const a = roster.find(x => x.id === recipient)
        return a
          ? { id: a.id, name: a.name, avatarEmoji: a.avatarEmoji ?? '🤖', avatarUrl: a.avatarUrl ?? null, role: a.role ?? null }
          : { id: ARTURITA_CHOICE, name: 'Arturita', avatarEmoji: '🌸', role: 'Chief of Staff' }
      })()

  const recogRef = useRef<any>(null)
  const braveRef = useRef(false)
  const mediaRecRef = useRef<any>(null)
  const chunksRef = useRef<Blob[]>([])
  const whisperUrlRef = useRef(WHISPER_DEFAULT_URL)
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  const threadRef = useRef<string | null>(null)
  const wakeRef = useRef(wakeWord)
  const delegateRef = useRef(delegate)
  const recipientRef = useRef(recipient)
  const voiceRef = useRef(voiceReplies)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { wakeRef.current = wakeWord }, [wakeWord])
  useEffect(() => { recipientRef.current = recipient }, [recipient])

  // GC-2 — hydrate persisted thread on load and when the picker recipient changes.
  const loadPersistedThread = useCallback(async (choice: string) => {
    try {
      const token = await getToken()
      const wire = toWireAgentId(choice)
      const q = wire ? `?agentId=${encodeURIComponent(wire)}` : ''
      const r = await api<{ turns: Parameters<typeof persistedTurnsToMessages>[0]; taskThreadId: string | null; jiraProjectKey?: string | null }>(
        `/api/orgs/${orgId}/arturita/thread${q}`, { token })
      setMessages(persistedTurnsToMessages(r.turns))
      threadRef.current = r.taskThreadId
      if (jiraProjects.length) {
        setSelectedProject(resolveJiraProjectSelection(jiraProjects, r.jiraProjectKey, jiraDefaultKey))
      }
    } catch { /* empty thread is fine on first visit */ }
  }, [orgId, getToken, jiraProjects, jiraDefaultKey])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const status = await api<{ connected: boolean; defaultProjectKey?: string | null }>(`/api/orgs/${orgId}/jira/status`, { token })
        if (cancelled) return
        setJiraConnected(!!status.connected)
        setJiraDefaultKey(status.defaultProjectKey ?? null)
        if (!status.connected) {
          setJiraProjects([])
          setSelectedProject('')
          return
        }
        const listed = await api<{ projects: JiraProjectOption[] }>(`/api/orgs/${orgId}/jira/projects`, { token })
        if (cancelled) return
        setJiraProjects(listed.projects ?? [])
        const thread = await api<{ jiraProjectKey?: string | null }>(`/api/orgs/${orgId}/arturita/thread`, { token })
        if (cancelled) return
        setSelectedProject(resolveJiraProjectSelection(listed.projects ?? [], thread.jiraProjectKey, status.defaultProjectKey ?? null))
      } catch {
        if (!cancelled) setJiraProjectHint('Could not load Jira projects')
      }
    })()
    return () => { cancelled = true }
  }, [orgId, getToken])

  const persistProjectSelection = useCallback(async (projectKey: string) => {
    if (!projectKey) return
    try {
      const token = await getToken()
      await api<{ jiraProjectKey: string | null }>(`/api/orgs/${orgId}/arturita/project`, {
        token, method: 'PUT', body: JSON.stringify({ projectKey }),
      })
      setJiraProjectHint(null)
    } catch (e: any) {
      setJiraProjectHint(e?.message ?? 'Could not save project selection')
    }
  }, [orgId, getToken])

  useEffect(() => { loadPersistedThread(recipient) }, [recipient, loadPersistedThread])
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

  // GC-1 — load the roster for the "To:" picker. Non-fatal: if it fails the picker
  // simply offers Arturita, which is the default anyway, so the chat still works.
  // Arturita is filtered out of the list because she IS the default entry.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await api<{ agents: RosterAgent[] }>(`/api/orgs/${orgId}/agents`, { token: await getToken() })
        if (cancelled) return
        setRoster((r.agents ?? []).filter(a => a.agentType !== 'arturita' && a.status !== 'terminated'))
      } catch { /* picker falls back to Arturita-only */ }
    })()
    return () => { cancelled = true }
  }, [orgId, getToken])

  // Resolve a browser-reachable local Ollama from the pipeline config (once).
  // Also probe the hosted answer chain (S3-B) so the banner/self-test don't falsely
  // read "cloud fallback" when Fly Ollama is the real path.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cfg = await api<{ llm: Array<{ provider?: string; model?: string; mode?: string }> }>(`/api/orgs/${orgId}/arturita/pipeline`, { token: await getToken() })
        const primary = (cfg.llm ?? []).find(e => e.mode === 'local' && e.provider === 'ollama' && e.model)
        if (primary?.model) {
          const models = await probeOllama(DEFAULT_OLLAMA_URL)
          if (!cancelled && models) {
            const base = String(primary.model).split(':')[0]
            if (models.some(m => m === primary.model || m.split(':')[0] === base)) {
              setLocalLlm({ model: primary.model!, baseUrl: DEFAULT_OLLAMA_URL })
            }
          }
        }
        const status = await api<{ answerUsable?: boolean; answerProvider?: string; answerModel?: string }>(
          `/api/orgs/${orgId}/arturita/llm-status`, { token: await getToken() },
        )
        if (!cancelled && status.answerUsable && status.answerProvider === 'ollama' && status.answerModel) {
          setHostedLlm({ model: status.answerModel })
        }
      } catch { /* no local/hosted Ollama reachable → backend chain handles it */ }
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

  // ── CC-ATT: attach a document to the next turn ───────────────────────────────
  // Extraction happens on PICK, not on send: the operator learns immediately that
  // a scanned PDF has no text layer, instead of after composing a question about
  // it. The file itself never leaves this handler — only the extracted text is
  // held, and only until the turn is sent.
  const pickAttachment = useCallback(async (file: File) => {
    setErr(null); setNotice(null)
    const local = rejectAttachment({ name: file.name, size: file.size })
    if (local) { setNotice({ tone: 'warn', text: local }); return }

    setAttaching(true)
    setAttachment({ name: file.name, size: file.size })   // chip shows while parsing
    try {
      const form = new FormData()
      form.append('file', file, file.name)
      const res = await api<{ attachment: { name: string; text: string; truncated: boolean }; truncated: boolean }>(
        `/api/orgs/${orgId}/arturita/attachments/extract`,
        { token: await getToken(), method: 'POST', body: form },
      )
      setAttachment({ name: file.name, size: file.size, text: res.attachment.text, truncated: res.truncated })
      if (res.truncated) {
        setNotice({ tone: 'info', text: `“${file.name}” is long, so I've attached the first part of it. I'll tell you if an answer needs the rest.` })
      }
    } catch (e: any) {
      // The backend's message is already operator-facing ("I can't read .mp4
      // files…"), so surface it as-is rather than a generic upload failure.
      setAttachment(null)
      const raw = String(e?.message ?? '')
      const clean = raw.replace(/^HTTP \d+:\s*/, '')
      setNotice({ tone: 'warn', text: clean || `I couldn't read “${file.name}”.` })
    } finally {
      setAttaching(false)
      if (fileRef.current) fileRef.current.value = ''   // re-picking the same file must re-fire
    }
  }, [orgId, getToken])

  // ── MOB-7b: attach a photo to the next turn ─────────────────────────────────
  // No server round-trip on pick, unlike a document: there is nothing to extract,
  // so the file is read to base64 right here and held until the turn is sent. The
  // photo never touches the network until Send — and then only as part of the
  // turn, which the backend keeps for the request and nothing longer.
  const pickImage = useCallback(async (file: File) => {
    setErr(null); setNotice(null)
    const local = rejectImage({ name: file.name, size: file.size })
    if (local) { setNotice({ tone: 'warn', text: local }); return }

    const mediaType = imageMediaType(file)
    setReading(true)
    setImage({ name: file.name, size: file.size, mediaType })   // chip shows while reading
    try {
      const data = await readAsBase64(file)
      setImage({ name: file.name, size: file.size, mediaType, data })
    } catch {
      setImage(null)
      setNotice({ tone: 'warn', text: `I couldn't read “${file.name}”.` })
    } finally {
      setReading(false)
      if (photoRef.current) photoRef.current.value = ''   // re-picking the same file must re-fire
    }
  }, [])

  // ── Send a turn to the conversational front door ─────────────────────────────
  const send = useCallback(async (bodyText: string, explicit: boolean) => {
    const message = bodyText.trim()
    // A document or a photo alone is a valid turn ("read this" / "what's this?");
    // text alone is the norm.
    if (!canSendTurn({ typed: message, attachment, image, busy: thinking || attaching || reading })) return
    const sentAttachment = attachment
    const sentImage = image
    setErr(null); setNotice(null); setShowConvo(true)
    // The bubble names the document/photo so the thread stays readable later — but
    // neither the document's TEXT nor the photo's BYTES go in the transcript (they
    // would re-enter the prompt as history on every later turn, and re-bill, for
    // no benefit).
    const bubbleText = [
      message,
      sentAttachment ? `📎 ${attachmentChipLabel(sentAttachment)}` : '',
      sentImage ? `🖼 ${imageChipLabel(sentImage)}` : '',
    ].filter(Boolean).join('\n\n')
    const userMsg: Message = { id: nextId(), role: 'user', text: bubbleText }
    setMessages(m => [...m, userMsg])
    setAttachment(null)   // the attachment rides THIS turn only
    setImage(null)        // …and so does the photo
    setThinking(true)
    const reqHistory = [...messages, userMsg]
    const sentTo = recipientRef.current
    const baseReq = toConverseRequest({ message, explicitDelegate: explicit, existingThreadId: threadRef.current, history: reqHistory, attachment: sentAttachment, image: sentImage, agentId: sentTo })
    // GC-1 — a turn addressed to a REAL agent can never be deferred to local Ollama.
    // Deferring hands the built prompt back for the browser to stream, which only
    // works for Arturita's single conversational turn; an agent turn must run in the
    // EXECUTOR (its memory, its connectors, the CONN-7 gate). Without this the picker
    // would silently apply on cloud turns and be ignored whenever local Ollama is up
    // — the operator would think he was talking to Bruno and be talking to Arturita.
    const addressedToAgent = !!baseReq.agentId
    const post = async (body: object) => api<ConverseResponse>(`/api/orgs/${orgId}/arturita/converse`, { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
    // When the backend answered but no LLM was reachable (degraded/text_only),
    // surface the actionable fix (enable local Ollama, or add a free cloud key)
    // right under the transcript instead of leaving only a ⚠ badge on the bubble.
    const noticeIfDegraded = (r: ConverseResponse) => {
      // A no-vision reply is degraded AND text_only, but "no language model was
      // reachable" would be a lie about it — a model answered, it just can't see.
      // Its own reply already names the fix, so don't talk over it.
      if (r.code === 'no_vision_model') return
      if (r.degraded || r.reply?.provider === 'text_only') setNotice({ tone: 'warn', text: `No language model was reachable for that reply. ${NO_LLM_FIX_HINT} Open ⚙ Pipeline config below and “Run self-test” to check each leg.` })
    }
    try {
      // A photo turn is never deferred to local Ollama: the local engine is
      // text-only by default, so streaming there would drop the image silently.
      // The backend enforces this too — this just keeps the request honest.
      const resp = await post({ ...baseReq, deferAnswer: !!localLlm && !sentImage && !addressedToAgent })

      // Delegate → the office runs it as a task (gated at A2 if destructive).
      if (resp.mode === 'delegate') {
        const arturita = toArturitaMessage({ id: nextId(), resp })
        if (arturita.taskId) threadRef.current = arturita.taskId
        setThinking(false); setMessages(m => [...m, arturita]); setReveal({ id: arturita.id, shown: 0 }); setSpeaking(true)
        return
      }

      // Answer deferred to the client → stream tokens live from local Ollama.
      if (resp.deferred && resp.prompt && localLlm && !addressedToAgent) {
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
  }, [orgId, getToken, messages, thinking, attaching, attachment, localLlm, speak])

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

  // A document with no typed message is a valid turn — `send` reads the
  // attachment from state, so it still has something to work with.
  const submitTyped = () => { const t = typed.trim(); if (!canSendTurn({ typed: t, attachment, image, busy: thinking || attaching || reading })) return; setTyped(''); send(t, delegate) }

  const provenance = provenanceChip({ local: localLlm, hosted: localLlm ? null : hostedLlm })
  const reactorChipRow = reactorChips({ provenance, captureLabel: sttEngine === 'none' ? '' : sttEngineLabel(sttEngine), voiceReplies })

  return (
    <div style={{ ...ui.page, maxWidth: 920, gap: space.xl }}>
      {/* ── Glass hero: the reactor is the PRINCIPAL Command Center view ─────── */}
      <div className="mc-hero" style={{ padding: `${space.xxl}px ${space.xl}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.lg }}>
        <Reactor state={voiceState} chips={reactorChipRow} />
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
            : hostedLlm
              ? <>🖥 Answering via hosted <b>{hostedLlm.model}</b> (Fly Ollama) — free, no cloud key needed.</>
              : <>☁ Using the cloud fallback chain. <span title="Run Ollama with OLLAMA_ORIGINS set to this app's origin to go fully local & free, or rely on hosted Fly Ollama when Pipeline keys are empty.">Local Ollama not detected on this machine.</span></>}
        </p>
      </div>

      {/* ── Reveal the transcript + settings; the reactor stays the hero ─────── */}
      <button
        type="button"
        onClick={() => setShowConvo(s => !s)}
        aria-expanded={showConvo}
        style={s.convoToggle}
      >
        {showConvo
          ? '▴ Hide conversation & settings'
          : `▾ Conversation & settings${messages.length ? ` · ${messages.length}` : ''}`}
      </button>

      {/* ── Conversation (behind the toggle; auto-opens on the first turn) ───── */}
      {showConvo && (
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
      )}

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
        {/* ── Attached document chip (CC-ATT) — name + size, removable ───────── */}
        {attachment && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start',
            background: 'var(--info-bg)', border: '1px solid var(--accent-line)',
            borderRadius: tk.r.md, padding: `${space.xxs}px ${space.sm}px`,
            fontSize: text.sm.fontSize, maxWidth: '100%',
          }}>
            <span aria-hidden>📎</span>
            <span style={{ color: tk.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {attachmentChipLabel(attachment)}
            </span>
            <span style={{ color: tk.muted }}>{attaching ? '· reading…' : ''}</span>
            <button
              onClick={() => { setAttachment(null); setNotice(null) }}
              aria-label={`Remove ${attachment.name}`}
              style={{ background: 'transparent', border: 'none', color: tk.muted, cursor: 'pointer', padding: 0, fontSize: text.sm.fontSize }}
            >✕</button>
          </div>
        )}
        {/* ── Attached photo chip (MOB-7b) — thumbnail + name, removable ────── */}
        {image && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start',
            background: 'var(--info-bg)', border: '1px solid var(--accent-line)',
            borderRadius: tk.r.md, padding: `${space.xxs}px ${space.sm}px`,
            fontSize: text.sm.fontSize, maxWidth: '100%',
          }}>
            {/* A real thumbnail, not a glyph: the operator must be able to see
                WHICH photo is about to be sent, and it costs nothing — the bytes
                are already in memory. Falls back to the glyph while reading. */}
            {image.data
              ? <img
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={`Attached photo: ${image.name}`}
                  style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: tk.r.sm, flexShrink: 0 }}
                />
              : <span aria-hidden>🖼</span>}
            <span style={{ color: tk.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {imageChipLabel(image)}
            </span>
            <span style={{ color: tk.muted }}>{reading ? '· reading…' : ''}</span>
            <button
              onClick={() => { setImage(null); setNotice(null) }}
              aria-label={`Remove ${image.name}`}
              style={{ background: 'transparent', border: 'none', color: tk.muted, cursor: 'pointer', padding: 0, fontSize: text.sm.fontSize }}
            >✕</button>
          </div>
        )}
        {/* ── GC-1 — the "To:" recipient bar ───────────────────────────────────
            ABOVE the input and always visible, never behind a menu. The operator
            has to know who is listening BEFORE he types something sensitive, so
            this is a persistent statement of the current recipient rather than a
            control he has to go and check. The avatar + name are the same
            treatment the transcript uses, so "who I'm talking to" and "who
            replied" read as one idea. */}
        <div style={s.recipientBar}>
          <span style={{ color: tk.muted, fontWeight: 700, fontSize: text.xs.fontSize, letterSpacing: 0.4 }}>TO</span>
          <AgentAvatar agent={{ name: activeRecipient.name, avatarEmoji: activeRecipient.avatarEmoji ?? '🤖', avatarUrl: activeRecipient.avatarUrl ?? null }} size={22} radius={tk.r.sm} />
          {/* FIX-1 AUDIT M-1 — the select sets `appearance: none` (to drop the UA's own
              intrinsic metrics, which were half of the baseline clipping), and that also
              removes the native dropdown caret. Nothing drew a replacement, so the
              control lost every visual cue that it IS a dropdown. This wrapper draws one.
              `pointer-events: none` so the caret never eats a click meant for the select,
              and `aria-hidden` because the select already announces itself. */}
          <span style={s.recipientWrap}>
            <select
              value={recipient}
              onChange={e => {
                setRecipient(e.target.value)
                // A new recipient is a new thread: `existingThreadId` names a task on the
                // PREVIOUS agent's queue, and carrying it over would file follow-up work
                // against an agent the operator is no longer addressing.
                threadRef.current = null
              }}
              aria-label="Choose which agent you are talking to"
              title="Choose which agent you are talking to"
              style={s.recipientSelect}
            >
              {/* AUDIT (cosmetic risk, de-risked without a browser): the SELECT is
                  transparent/borderless so it disappears into the pill, but a native
                  OPTION LIST does not inherit that — it is drawn by the browser. On the
                  dark theme a Chromium/Firefox popup would default to LIGHT chrome while
                  the options inherited the near-white `--text`: white on white,
                  unreadable. TWO things now prevent that, and the belt-and-braces is
                  deliberate: FIX-1 added the app-wide `color-scheme: dark|light` keyed on
                  [data-theme] (app/globals.css), which is the root fix and tells the
                  browser which palette to draw ALL native chrome in; these explicit
                  option colours remain as the local backstop for any surface that renders
                  outside that declaration. macOS draws this popup with system chrome and
                  ignores option styling entirely — readable anyway, so a no-op there.
                  Still unverified in a real browser. */}
              <option value={ARTURITA_CHOICE} style={sxOption}>Arturita — Chief of Staff (default)</option>
              {roster.map(a => (
                <option key={a.id} value={a.id} style={sxOption}>{a.name}{a.role ? ` — ${a.role}` : ''}</option>
              ))}
            </select>
            <span aria-hidden style={s.recipientCaret}>▾</span>
          </span>
          {recipient !== ARTURITA_CHOICE && (
            <span style={{ ...tagStyle, background: 'var(--accent-dim)', color: 'var(--purple-1)' }} title="This turn runs as that agent — its own memory, tools and connectors">
              ⚡ agent
            </span>
          )}
        </div>
        {/* GC-3 — Jira project context. Data source is Jira, not the native projects table. */}
        <div style={s.recipientBar}>
          <span style={{ color: tk.muted, fontWeight: 700, fontSize: text.xs.fontSize, letterSpacing: 0.4 }}>PROJECT</span>
          {!jiraConnected ? (
            <span style={sxHint}>Connect Jira in Connectors to pick a project</span>
          ) : jiraProjects.length === 0 ? (
            <span style={sxHint}>No Jira projects available</span>
          ) : (
            <span style={s.recipientWrap}>
              <select
                value={selectedProject}
                onChange={e => {
                  const next = e.target.value
                  setSelectedProject(next)
                  void persistProjectSelection(next)
                }}
                aria-label="Choose the Jira project for Command Center context"
                title="Choose the Jira project for Command Center context"
                style={s.recipientSelect}
              >
                {jiraProjects.map(p => (
                  <option key={p.id} value={p.key} style={sxOption}>{jiraProjectLabel([p], p.key)}</option>
                ))}
              </select>
              <span aria-hidden style={s.recipientCaret}>▾</span>
            </span>
          )}
          {jiraProjectHint && <span style={{ ...sxHint, color: 'var(--warn)' }}>{jiraProjectHint}</span>}
        </div>
        <div style={{ display: 'flex', gap: space.sm }}>
          {/* The pickers are hidden; the paperclip/frame buttons drive them (a bare
              file input can't be styled to match the glass composer). Two separate
              inputs, not one: the OS dialog's filter is the first thing that tells
              the operator what each button is for. */}
          <input
            ref={fileRef}
            type="file"
            accept={ATTACH_ACCEPT}
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) pickAttachment(f) }}
          />
          <input
            ref={photoRef}
            type="file"
            accept={IMAGE_ACCEPT}
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) pickImage(f) }}
          />
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={attaching}
            aria-label="Attach a document"
            title="Attach a document (PDF, Word, Excel, PowerPoint, text…)"
          >📎</Button>
          <Button
            onClick={() => photoRef.current?.click()}
            disabled={reading}
            aria-label="Attach a photo"
            title="Attach a photo — Arturita can see it (JPG, PNG, GIF, WebP)"
          >🖼</Button>
          <TextInput
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitTyped() }}
            placeholder={attachment ? `Ask ${activeRecipient.name} about the attached document…` : `Message ${activeRecipient.name}…`}
            aria-label={`Message ${activeRecipient.name}`}
            style={{ flex: 1 }}
          />
          <Button variant="primary" disabled={!canSendTurn({ typed, attachment, image, busy: thinking || attaching || reading })} onClick={submitTyped}>{thinking ? '…' : 'Send'}</Button>
        </div>
        <label style={{ ...s.toggle, alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={delegate} onChange={e => setDelegate(e.target.checked)} />
          <span>▸ Delegate this to {recipient === ARTURITA_CHOICE ? 'the office' : activeRecipient.name} <span style={{ color: tk.muted }}>(instead of a direct answer)</span></span>
        </label>
      </Card>

      {/* ── Free-first pipeline config (LLM/STT/TTS chains) — under the toggle ─ */}
      {showConvo && <AssistantPipelineConfig orgId={orgId} getToken={getToken} />}
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
        {/* GC-1 — WHO WROTE THIS. A thread can switch agents mid-way, so attribution is
            per-bubble, read off the message rather than off current picker state.
            Keyed on `fromAgent` (set only for mode:'agent'), NOT on the presence of
            `agent`: on a delegate turn `agent` is Arturita — she wrote the ack — and on
            the default path this keeps the bubble byte-identical to pre-GC-1, a bare 🌸
            with no name. Who the work went TO is a separate chip below. */}
        {msg.fromAgent && msg.agent
          ? <>
              <AgentAvatar agent={{ name: msg.agent.name, avatarEmoji: msg.agent.avatarEmoji ?? '🤖', avatarUrl: msg.agent.avatarUrl ?? null }} size={20} radius={tk.r.sm} />
              <span style={{ fontSize: text.sm.fontSize, fontWeight: 700, color: tk.text }}>{msg.agent.name}</span>
            </>
          : <span style={{ fontSize: 15 }}>🌸</span>}
        <span style={{ ...tagStyle, background: badgeStyle.bg, color: badgeStyle.fg }}>{badge.icon} {badge.label}</span>
        {/* The ASSIGNEE — deliberately a chip beside the badge, never the speaker. */}
        {msg.assignedTo && (
          <span style={{ ...tagStyle, background: 'var(--accent-dim)', color: 'var(--purple-1)' }} title="who the work was handed to">
            → assigned to {msg.assignedTo.name}
          </span>
        )}
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
      {/* GC-1 — an action from this turn parked at the CONN-7 gate. It already reached
          the Inbox and push, but the operator is looking HERE: without this line a
          gated connector call reads as the agent having quietly done nothing. */}
      {msg.pendingApprovalNote && (
        <div style={{ fontSize: text.xs.fontSize, color: tk.amber, background: 'var(--warn-bg)', border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, padding: `${space.xs}px ${space.sm}px`, marginTop: space.xxs }}>
          ⏸ {msg.pendingApprovalNote}
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

/** GC-1 audit — explicit colours for the recipient picker's native option list, which
 *  does NOT inherit the transparent select's styling. Theme variables, so it follows the
 *  light/dark toggle. See the comment at the call site. */
const sxOption: React.CSSProperties = { background: 'var(--s1)', color: 'var(--text)' }

const tagStyle: React.CSSProperties = { fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700, borderRadius: tk.r.pill, padding: '1px 8px', whiteSpace: 'nowrap' }
const sxHint: React.CSSProperties = { fontSize: text.xs.fontSize, color: tk.muted, margin: 0 }

const s: Record<string, React.CSSProperties> = {
  // GC-1 — the recipient bar sits above the composer and reads as part of it.
  recipientBar: {
    display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap',
    padding: `${space.xs}px ${space.sm}px`, marginBottom: space.xs,
    background: 'var(--s2)', border: '1px solid var(--line-strong)',
    borderRadius: tk.r.pill,
  },
  // FIX-1 — this control CLIPPED its own label at the baseline in production
  // ("Arturita · Chief of Staff (default)" lost its descenders). The cause was
  // geometric, not cosmetic: a hard `height: 26` with `boxSizing: 'border-box'`,
  // no vertical padding, and `text.md`'s fontSize taken WITHOUT its 18px
  // lineHeight — an 18px line box does not fit in a 26px border box once the
  // UA's own select metrics are added on top.
  //
  // The fix is to stop pinning the height at all: `minHeight` on the shared
  // control token gives the pill its stable resting size, while the explicit
  // lineHeight + vertical padding let the box GROW rather than crop when the
  // operator zooms, bumps their default font size, or picks an agent with a
  // long name. `appearance: none` drops the UA's intrinsic metrics so ours are
  // the only ones in play; `maxWidth: 100%` keeps a long name from pushing the
  // pill wider than its container instead of ellipsising inside it.
  // FIX-1 AUDIT M-1 — positioning context for the caret the `appearance: none` above
  // removed. Carries the flex sizing the select used to own, so the bar lays out
  // exactly as before.
  recipientWrap: {
    flex: 1, minWidth: 180, maxWidth: '100%',
    position: 'relative', display: 'flex', alignItems: 'center',
  },
  recipientCaret: {
    position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
    pointerEvents: 'none', color: tk.muted, fontSize: text.xs.fontSize, lineHeight: 1,
  },
  recipientSelect: {
    flex: 1, minWidth: 0, maxWidth: '100%',
    minHeight: density.ctrl, boxSizing: 'border-box',
    // Right padding reserves the caret's lane, so a long agent name ellipsises
    // BEFORE it reaches the glyph rather than running underneath it.
    padding: `${space.xs}px ${space.lg}px ${space.xs}px 0`,
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    background: 'transparent', border: 'none', outline: 'none',
    color: tk.text, fontSize: text.md.fontSize, lineHeight: text.md.lineHeight,
    fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
    textOverflow: 'ellipsis',
  },
  toggle: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: text.sm.fontSize, color: tk.textDim, cursor: 'pointer', userSelect: 'none' },
  interim: { minHeight: 20, fontSize: text.sm.fontSize, lineHeight: 1.5 },
  convoToggle: {
    alignSelf: 'center', background: 'var(--s2)', border: '1px solid var(--line-strong)',
    color: tk.textDim, borderRadius: tk.r.pill, padding: '5px 16px', cursor: 'pointer',
    fontSize: text.sm.fontSize, fontWeight: 700, letterSpacing: 0.3,
  },
}
