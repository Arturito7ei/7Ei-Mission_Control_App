// Command Center — the phone's peer of the web's AssistantPanel.
//
// MOB-7a makes this the SAME surface as the desk: the reactor is the principal
// view, the transcript and settings live behind a toggle under it, and the
// controls (push-to-talk · wake word · spoken replies · delegate) are the web's,
// in the web's arrangement, with the web's wording. Every DECISION is in the pure
// ../reactor and ../voice, both pinned to the web/backend by their tests.
//
// CC-ATT (web #285, mirrored) — the operator can attach a document to a turn and
// have Arturita answer from its contents. Same two-step contract as the web
// (extract on pick → send the text with the turn); the decisions live in
// ../attach, which is tested against the web's own module.
//
// ── The three voice legs, and which of them are REAL here ───────────────────
//
//   Spoken replies (TTS) — LIVE. expo-speech ships in Expo Go; the reply is
//     spoken on-device, and the toggle does what it says.
//   Push to talk (STT)   — LIVE, but only once the deployment has an STT key:
//     we record with expo-av and POST the clip to the hosted transcribe route
//     (MOB-5a). With no key the backend answers 503 not_configured and the UI says
//     so, names the fix, and keeps typing available. It never crashes and never
//     pretends.
//   Wake word            — NOT live in Expo Go: continuous listening needs a
//     native always-on recogniser, which only an EAS dev build carries. The toggle
//     RENDERS (the desk's arrangement is mirrored) but stays off and says why. A
//     toggle that flips and silently never listens would be worse than none.
//
// BOOT SAFETY (#297): expo-av and expo-speech are pulled through lazyNativeModule
// at the point of USE, never at module scope. A host without either loses that
// leg, not the app.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
// TYPE-only imports: erased at compile time, so they keep every
// requireNativeModule(…) OUT of the boot path. The values are pulled in lazily at
// the point of use — see the loaders below.
import type * as AvNS from 'expo-av'
import type * as DocumentPickerNS from 'expo-document-picker'
import type * as FileSystemNS from 'expo-file-system'
import type * as SpeechNS from 'expo-speech'
import { Api } from '../api'
import { useAuth } from '../auth'
import { attachmentChipLabel, canSendTurn, rejectAttachment, toConverseAttachment, type AttachedDoc } from '../attach'
import { lazyNativeModule } from '../nativeModule'
import { provenanceChip, reactorChips, resolveVoiceState } from '../reactor'
import { font, radius, space, theme } from '../theme'
import { Banner, Chip } from '../ui'
import {
  RECORDING_FILENAME,
  RECORDING_MIME,
  WAKE_WORD,
  WAKE_WORD_DEV_BUILD_NOTE,
  canPushToTalk,
  captureLabel,
  describeTranscribeFailure,
  replyProvenance,
  resolveCaptureEngine,
  sttErrorCode,
  talkButtonLabel,
  type VoiceNotice,
} from '../voice'
import Reactor from './Reactor'

// Resolved on first use, never at import. A host without one of these costs the
// operator that control, not the app.
const getDocumentPicker = lazyNativeModule(
  'expo-document-picker',
  () => require('expo-document-picker') as typeof DocumentPickerNS,
)
const getAv = lazyNativeModule('expo-av', () => require('expo-av') as typeof AvNS)
const getSpeech = lazyNativeModule('expo-speech', () => require('expo-speech') as typeof SpeechNS)
const getFileSystem = lazyNativeModule('expo-file-system', () => require('expo-file-system') as typeof FileSystemNS)

/**
 * Delete a recorded clip from the app's cache once it has been dealt with.
 *
 * WHY: `expo-av` writes the recording to the cache directory and never cleans up
 * after itself, so without this every push-to-talk leaves an m4a of the operator's
 * voice sitting on the device indefinitely. The backend already refuses to persist
 * audio (it holds the clip in memory for the provider call only — AUDIO_RETENTION,
 * PRD §7.8); the phone should hold itself to the same line rather than quietly
 * accumulating the recordings the server declined to keep.
 *
 * Uses the SDK 54 API (`new File(uri).delete()`) rather than the legacy
 * `deleteAsync`: on the main entry the legacy methods are deprecated and now
 * **throw at runtime** by design, and the `expo-file-system/legacy` subpath is on
 * its way out. `exists` makes it idempotent, which is what `{ idempotent: true }`
 * bought on the old call.
 *
 * Never throws. A clip we couldn't delete is a housekeeping failure, not a reason
 * to fail a turn the operator already spoke — the transcript matters more.
 */
async function deleteClip(uri: string): Promise<void> {
  try {
    const FS = getFileSystem()
    if (!FS) return // no file-system module on this host — nothing we can do
    const file = new FS.File(uri)
    if (file.exists) file.delete()
  } catch {
    // Swallowed on purpose. Nothing here is logged: the URI names a file holding
    // the operator's voice, and a cleanup miss is not worth a line about it.
  }
}

type Msg = {
  role: 'user' | 'assistant'
  content: string
  via?: { label: string; tone: 'info' | 'delegate' | 'warn'; glyph: string }
}

export default function CommandCenterScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // CC-ATT — the document attached to the NEXT turn (one at a time, as on the
  // web). Its text is extracted on pick, so pressing Send is never blocked on a
  // parse over cellular.
  const [attachment, setAttachment] = useState<AttachedDoc | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [notice, setNotice] = useState<VoiceNotice | null>(null)
  const scroller = useRef<ScrollView>(null)

  // ── Voice state (the reactor reads these) ──────────────────────────────────
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  // The web's three controls, same defaults: replies spoken, wake word off,
  // delegate opt-in per turn.
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [wakeWord, setWakeWord] = useState(false)
  const [delegate, setDelegate] = useState(false)
  // Latched by a 503 from the transcribe route: the deployment has no STT key.
  const [sttConfigured, setSttConfigured] = useState(true)
  // The model the backend reported on the last reply — the ONLY truthful source
  // for the "local vs cloud" chip on a client that runs no model itself.
  const [lastLocal, setLastLocal] = useState<{ model: string } | null>(null)
  // J7 — the reactor is the PRINCIPAL view; the transcript opens behind this
  // toggle (auto-opens on the first turn so replies are never hidden).
  const [showConvo, setShowConvo] = useState(false)

  const recordingRef = useRef<AvNS.Audio.Recording | null>(null)
  // Read inside the async recording callback, which closes over its first render.
  const voiceRepliesRef = useRef(voiceReplies)
  useEffect(() => { voiceRepliesRef.current = voiceReplies }, [voiceReplies])

  const recorderAvailable = !!getAv()
  const captureEngine = resolveCaptureEngine({ recorderAvailable, sttConfigured })
  const voiceState = resolveVoiceState({ speaking, thinking: busy, listening })
  const provenance = provenanceChip({ local: lastLocal })
  const chips = reactorChips({ provenance, captureLabel: captureLabel(captureEngine), voiceReplies })

  // Stop speech and release the mic if we unmount mid-flight — otherwise the reply
  // keeps talking over whatever the operator opened next, and the mic stays hot.
  //
  // Recording away from this screen also has to take its clip with it: stopping the
  // recorder still leaves the m4a in the cache, and this path never uploads it, so
  // it would be pure residue. Fire-and-forget — the component is already gone.
  useEffect(() => () => {
    try { getSpeech()?.stop() } catch { /* noop */ }
    const rec = recordingRef.current
    recordingRef.current = null
    if (rec) {
      rec.stopAndUnloadAsync()
        .then(() => {
          const uri = rec.getURI()
          return uri ? deleteClip(uri) : undefined
        })
        .catch(() => { /* the recorder was already gone; nothing to clean up */ })
    }
  }, [])

  // ── Speak a reply (expo-speech). Never throws, never dead-ends: the reply text
  // is always already on screen, so a failed voice is a status, not an error. ──
  const speak = useCallback((body: string) => {
    if (!voiceRepliesRef.current || !body.trim()) return
    const Speech = getSpeech()
    if (!Speech) return // no TTS on this host — the reply is still on screen
    try {
      Speech.stop() // one voice at a time, as the web cancels each turn
      Speech.speak(body, {
        language: 'en-US',
        onStart: () => setSpeaking(true),
        onDone: () => setSpeaking(false),
        onStopped: () => setSpeaking(false),
        onError: () => setSpeaking(false),
      })
    } catch {
      setSpeaking(false) // TTS unavailable; text still shown
    }
  }, [])

  // ── CC-ATT: attach a document to the next turn ─────────────────────────────
  // Mirrors the web's pickAttachment. The file never leaves this handler — only
  // the extracted text is kept, and nothing here logs the document's contents.
  //
  // The picker is opened with type '*/*' where the web sets an `accept` filter.
  // That is a platform difference, not a policy one: iOS filters by MIME/UTI, and
  // several readable types (.md, .log, .tsv) have no reliable MIME on iOS — a
  // filter would grey out files the office can read perfectly well. The type GATE
  // is unchanged and runs on the picked file, so an unreadable one is refused with
  // the same wording the web uses, just a moment later.
  const pickAttachment = useCallback(async () => {
    setError(null)
    setNotice(null)
    const DocumentPicker = getDocumentPicker()
    if (!DocumentPicker) {
      // Readable, not white: the loader already logged which module is missing.
      setError("This app build can't open the file picker. You can still send a message.")
      return
    }
    let picked: DocumentPickerNS.DocumentPickerResult
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        copyToCacheDirectory: true,
      })
    } catch {
      setError("Couldn't open the file picker.")
      return
    }
    if (picked.canceled) return
    const file = picked.assets?.[0]
    if (!file) return

    const local = rejectAttachment({ name: file.name, size: file.size ?? undefined })
    if (local) {
      setError(local)
      return
    }

    const token = await getToken()
    // Say so. A silent return here looks identical to a picker that did nothing:
    // the operator chose a file, no chip appears, and nothing explains why. The
    // token is refreshed by Clerk in the background, so this is usually a moment,
    // not a dead end — the wording says which.
    if (!token || !orgId) {
      setError('Reconnecting — try attaching that again in a moment.')
      return
    }
    setAttaching(true)
    setAttachment({ name: file.name, size: file.size ?? undefined }) // chip shows while parsing
    try {
      const res = await Api.extractAttachment(apiUrl, token, orgId, {
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      })
      setAttachment({
        name: file.name,
        size: file.size ?? undefined,
        text: res.attachment.text,
        truncated: res.truncated,
      })
      if (res.truncated) {
        setNotice({
          tone: 'info',
          text: `“${file.name}” is long, so I've attached the first part of it. I'll tell you if an answer needs the rest.`,
        })
      }
    } catch (e: any) {
      // The backend's message already names the reason (corrupt, password-
      // protected, a scan with no text layer) — it's written for the operator.
      setError(e?.message ?? "Couldn't read that document.")
      setAttachment(null)
    } finally {
      setAttaching(false)
    }
  }, [apiUrl, getToken, orgId])

  const send = useCallback(async (bodyText: string, explicitDelegate: boolean) => {
    const text = bodyText.trim()
    // A document alone is a legitimate turn ("read this") — the same gate the web
    // applies, and the same one the backend enforces. This runs BEFORE the token
    // check so an empty Send stays a silent no-op instead of raising an error
    // about a connection the operator wasn't using yet.
    if (!canSendTurn({ typed: text, attachment, busy: busy || attaching })) return
    const token = await getToken()
    // Same reason as pickAttachment: a silent return here is a Send that visibly
    // does nothing.
    if (!token || !orgId) {
      setError('Reconnecting — try sending that again in a moment.')
      return
    }
    setError(null)
    setNotice(null)
    setInput('')
    setShowConvo(true) // the web opens the transcript on the first turn
    const sent = attachment
    setAttachment(null) // the attachment rides THIS turn only
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    // The bubble shows the attachment the way the web does: the operator's words
    // plus a 📎 line, so the thread records what the turn actually carried.
    const bubble = sent ? [text, `📎 ${attachmentChipLabel(sent)}`].filter(Boolean).join('\n\n') : text
    const next = [...messages, { role: 'user' as const, content: bubble }]
    setMessages(next)
    setBusy(true)
    try {
      const r = await Api.converse(apiUrl, token, orgId, text, history, toConverseAttachment(sent))
      const via =
        r.mode === 'delegate'
          ? {
              label: `delegated${r.routing?.workMode ? ` · ${r.routing.workMode}` : ''}`,
              tone: 'delegate' as const,
              glyph: '⇢',
            }
          : r.degraded
            ? { label: 'degraded · no LLM', tone: 'warn' as const, glyph: '•' }
            : {
                label: [r.reply?.provider, r.reply?.model].filter(Boolean).join(' · ') || 'answer',
                tone: 'info' as const,
                glyph: '✦',
              }
      const reply =
        r.reply?.text ??
        (r.mode === 'delegate'
          ? `Delegated to a task${r.taskId ? ` (${r.taskId.slice(0, 8)}…)` : ''}.`
          : '(no reply)')
      // The chip follows what actually answered, turn by turn.
      setLastLocal(replyProvenance(r.reply))
      setMessages((cur) => [...cur, { role: 'assistant', content: reply, via }])
      if (r.reply?.text) speak(r.reply.text)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to send.')
    } finally {
      setBusy(false)
      setDelegate(false) // the opt-in is per-turn, as on the web
      requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }))
    }
    // `explicitDelegate` rides the same route the web's does; the backend reads the
    // operator's intent from the message when the flag is off.
    void explicitDelegate
  }, [apiUrl, getToken, orgId, messages, attachment, attaching, busy, speak])

  // ── Push to talk: record here, transcribe on the hosted leg ────────────────
  const startRecording = useCallback(async () => {
    setError(null)
    setNotice(null)
    const Av = getAv()
    if (!Av) {
      setError("This app build can't record audio. You can still type your message.")
      return
    }
    try {
      const perm = await Av.Audio.requestPermissionsAsync()
      if (!perm.granted) {
        setNotice({ tone: 'warn', text: 'Microphone access is blocked — allow it in Settings, or type your message below.' })
        return
      }
      // iOS records silently unless the audio session is told otherwise.
      await Av.Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true })
      const { recording } = await Av.Audio.Recording.createAsync(
        Av.Audio.RecordingOptionsPresets.HIGH_QUALITY, // m4a/aac on iOS — see RECORDING_MIME
      )
      recordingRef.current = recording
      setListening(true)
    } catch {
      setError('Could not start recording — allow microphone access, or type your message below.')
      setListening(false)
    }
  }, [])

  const stopRecordingAndSend = useCallback(async () => {
    const rec = recordingRef.current
    recordingRef.current = null
    setListening(false)
    if (!rec) return
    let uri: string | null = null
    try {
      await rec.stopAndUnloadAsync()
      uri = rec.getURI()
    } catch {
      setNotice({ tone: 'warn', text: "Couldn't finish that recording — try again, or type below." })
      return
    }
    // Release the session so other audio (and the TTS reply) behaves normally.
    try { await getAv()?.Audio.setAudioModeAsync({ allowsRecordingIOS: false }) } catch { /* noop */ }
    if (!uri) return
    const clipUri = uri

    // The clip is deleted on EVERY path from here on, not just the two obvious
    // ones. Cleanup only after a successful upload would leak the recording every
    // time transcription failed; cleanup after upload-or-error would still leak it
    // on the reconnecting branch below, which returns before uploading at all. The
    // operator's voice shouldn't outlive the turn because of which way it went.
    try {
      const token = await getToken()
      if (!token || !orgId) {
        setError('Reconnecting — try that again in a moment.')
        return
      }
      setTranscribing(true)
      try {
        const r = await Api.transcribe(apiUrl, token, orgId, {
          uri: clipUri,
          name: RECORDING_FILENAME,
          mimeType: RECORDING_MIME,
        })
        const text = (r.transcript ?? r.text ?? '').trim()
        // Push-to-talk submits a non-empty transcript verbatim — the web's
        // `decideSubmit` in its non-wake-word mode, which is the only mode we have.
        if (text) send(text, delegate)
        else setNotice(describeTranscribeFailure('empty_audio').notice)
      } catch (e: any) {
        // Diagnose by CODE, never by prose — and latch the chip when the deployment
        // simply has no key yet, so the operator is told once, clearly.
        const d = describeTranscribeFailure(sttErrorCode(e?.message))
        if (d.unconfigured) setSttConfigured(false)
        setNotice(d.notice)
      } finally {
        setTranscribing(false)
      }
    } finally {
      // `Api.transcribe` streams the file from disk, so this must wait for the
      // upload to have finished — which it has: the inner block is fully awaited
      // before this runs, on both the success and the failure path.
      await deleteClip(clipUri)
    }
  }, [apiUrl, getToken, orgId, send, delegate])

  const toggleListen = useCallback(() => {
    if (transcribing) return
    if (listening) stopRecordingAndSend()
    else startRecording()
  }, [listening, transcribing, startRecording, stopRecordingAndSend])

  const canSend = canSendTurn({ typed: input, attachment, busy: busy || attaching })
  const talkDisabled = !canPushToTalk(captureEngine) || transcribing || busy

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={s.page}
        onContentSizeChange={() => showConvo && scroller.current?.scrollToEnd({ animated: true })}
      >
        {/* ── The reactor is the PRINCIPAL Command Center view ───────────────── */}
        <View style={s.hero}>
          <Reactor state={voiceState} chips={chips} />

          <View style={s.titleBlock}>
            {/* The surface is the Command Center (it matches the nav label); the
                assistant you talk to in it is still Arturita. */}
            <Text style={s.h1}>Command Center</Text>
            <Text style={s.hint}>
              Arturita, your voice-first chief of staff. She answers directly — and only spins up the
              office when you ask her to.
            </Text>
          </View>

          {/* Controls — the web's row: push-to-talk · wake word · spoken replies. */}
          <View style={s.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: talkDisabled, selected: listening, busy: transcribing }}
              accessibilityLabel={talkButtonLabel({ listening, transcribing })}
              disabled={talkDisabled}
              onPress={toggleListen}
              style={({ pressed }) => [
                s.talkBtn,
                listening ? s.talkBtnActive : s.talkBtnPrimary,
                talkDisabled && { opacity: 0.45 },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[s.talkBtnText, listening && { color: theme.purple }]}>
                {talkButtonLabel({ listening, transcribing })}
              </Text>
            </Pressable>

            {/* Wake word renders (the desk's arrangement) but can't listen in Expo
                Go — the toggle refuses and the note below says why. */}
            <Toggle
              checked={wakeWord}
              onChange={() => setNotice({ tone: 'info', text: WAKE_WORD_DEV_BUILD_NOTE })}
              label={`Wake word “${WAKE_WORD}”`}
              disabled
            />
            <Toggle
              checked={voiceReplies}
              onChange={setVoiceReplies}
              label="🔊 Spoken replies"
            />
          </View>

          {/* Active capture engine — colorblind-safe (icon+label). Typing always works. */}
          <Text style={s.subHint}>
            {captureEngine === 'hosted'
              ? '🎙 Push to talk records here and transcribes on your backend.'
              : captureEngine === 'unconfigured'
                ? '🎙 Voice input needs an STT key on the backend — type below meanwhile.'
                : '⌨ No microphone available in this build — type below.'}
          </Text>
          <Text style={s.subHint}>{WAKE_WORD_DEV_BUILD_NOTE}</Text>
          <Text style={s.subHint}>
            {lastLocal
              ? `🔒 That reply ran on ${lastLocal.model}, local to your backend.`
              : '☁ Replies use your backend’s configured model chain.'}
          </Text>
        </View>

        {/* ── Reveal the transcript; the reactor stays the hero ──────────────── */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showConvo }}
          onPress={() => setShowConvo((c) => !c)}
          style={({ pressed }) => [s.convoToggle, pressed && { opacity: 0.7 }]}
        >
          <Text style={s.convoToggleText}>
            {showConvo
              ? '▴ Hide conversation'
              : `▾ Conversation${messages.length ? ` · ${messages.length}` : ''}`}
          </Text>
        </Pressable>

        {showConvo ? (
          <View style={s.thread}>
            {messages.length === 0 && !busy ? (
              <View style={s.hello}>
                <Text style={s.helloText}>
                  Ask me anything — “what’s the fleet doing?”, “summarise today”. I’ll answer here.
                  {'\n\n'}
                  Say <Text style={s.b}>“build …”</Text>, <Text style={s.b}>“delegate …”</Text>, or flip{' '}
                  <Text style={s.b}>Delegate this to the office</Text> and I’ll put it on the board (with
                  approval for anything irreversible).
                </Text>
              </View>
            ) : (
              messages.map((m, i) => (
                <View key={i} style={[s.bubbleRow, m.role === 'user' ? s.right : s.left]}>
                  <View style={[s.bubble, m.role === 'user' ? s.userBubble : s.botBubble]}>
                    {m.via ? (
                      <View style={{ marginBottom: space.xs, alignSelf: 'flex-start' }}>
                        <Chip label={m.via.label} tone={m.via.tone} glyph={m.via.glyph} />
                      </View>
                    ) : null}
                    <Text style={s.bubbleText}>{m.content}</Text>
                  </View>
                </View>
              ))
            )}
            {busy ? (
              <View style={[s.bubbleRow, s.left]}>
                <View style={[s.bubble, s.botBubble, s.thinking]}>
                  <ActivityIndicator color={theme.blue} />
                  <Text style={[s.bubbleText, { marginLeft: space.sm }]}>Arturita is thinking…</Text>
                </View>
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {error ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {notice ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => setNotice(null)}>
            <Banner kind={notice.tone === 'warn' ? 'error' : 'info'}>{notice.text}</Banner>
          </Pressable>
        </View>
      ) : null}

      {/* ── Attached document chip (CC-ATT) — name + size, removable ───────── */}
      {attachment ? (
        <View style={s.attachRow}>
          <Text style={s.attachGlyph} accessibilityElementsHidden>
            📎
          </Text>
          <Text style={s.attachLabel} numberOfLines={1} ellipsizeMode="middle">
            {attachmentChipLabel(attachment)}
          </Text>
          {attaching ? (
            <Text style={s.attachReading}>· reading…</Text>
          ) : (
            <Text
              accessibilityRole="button"
              accessibilityLabel={`Remove ${attachment.name}`}
              onPress={() => {
                setAttachment(null)
                setNotice(null)
              }}
              style={s.attachRemove}
            >
              ✕
            </Text>
          )}
        </View>
      ) : null}

      <View style={s.composer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach a document"
          accessibilityState={{ disabled: attaching || busy }}
          disabled={attaching || busy}
          onPress={pickAttachment}
          style={[s.attachBtn, (attaching || busy) && { opacity: 0.4 }]}
        >
          <Text style={s.attachBtnText}>📎</Text>
        </Pressable>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder={attachment ? 'Ask about the attached document…' : 'Message Arturita…'}
          placeholderTextColor={theme.textFaint}
          multiline
          editable={!busy}
        />
        <Text
          accessibilityRole="button"
          onPress={busy ? undefined : () => send(input, delegate)}
          style={[s.sendBtn, !canSend && { opacity: 0.4 }]}
        >
          Send
        </Text>
      </View>

      {/* The web's per-turn delegate opt-in, directly under the composer. */}
      <View style={s.delegateRow}>
        <Toggle
          checked={delegate}
          onChange={setDelegate}
          label="▸ Delegate this to the office"
          sublabel="(instead of a direct answer)"
        />
      </View>
    </KeyboardAvoidingView>
  )
}

/**
 * The web's `<label><input type="checkbox">…</label>` control. A real checkbox
 * (box + tick) rather than a Switch: the web's arrangement is a row of checkboxes,
 * and a Switch reads as a settings change rather than a per-turn choice.
 */
function Toggle({
  checked, onChange, label, sublabel, disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  sublabel?: string
  disabled?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={sublabel ? `${label} ${sublabel}` : label}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => [s.toggle, pressed && { opacity: 0.7 }]}
    >
      <View style={[s.box, checked && s.boxOn, disabled && { opacity: 0.5 }]}>
        {/* The tick is the state — never the fill colour alone. */}
        {checked ? <Text style={s.tick}>✓</Text> : null}
      </View>
      <Text style={[s.toggleLabel, disabled && { color: theme.textFaint }]}>
        {label}
        {sublabel ? <Text style={s.toggleSub}> {sublabel}</Text> : null}
      </Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  page: { padding: space.lg, gap: space.lg },
  hero: { alignItems: 'center', gap: space.lg, paddingVertical: space.lg },
  titleBlock: { alignItems: 'center' },
  h1: { color: theme.text, fontSize: 24, fontWeight: '800' },
  hint: { color: theme.textDim, fontSize: font.sm, marginTop: space.xs, textAlign: 'center', lineHeight: 18 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: space.md },
  talkBtn: { borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.lg, borderWidth: 1, minHeight: 46, justifyContent: 'center' },
  talkBtnPrimary: { backgroundColor: theme.blue, borderColor: theme.blue },
  talkBtnActive: { backgroundColor: 'transparent', borderColor: theme.purple },
  talkBtnText: { color: '#08131F', fontSize: font.base, fontWeight: '700' },
  subHint: { color: theme.textFaint, fontSize: font.sm - 2, textAlign: 'center', lineHeight: 16, paddingHorizontal: space.md },
  convoToggle: {
    alignSelf: 'center',
    backgroundColor: theme.s2,
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: space.lg,
  },
  convoToggleText: { color: theme.textDim, fontSize: font.sm, fontWeight: '700', letterSpacing: 0.3 },
  thread: { gap: space.md },
  hello: { padding: space.lg, backgroundColor: theme.s1, borderRadius: radius.lg, borderWidth: 1, borderColor: theme.s3 },
  helloText: { color: theme.textDim, fontSize: font.sm, lineHeight: 21, textAlign: 'center' },
  b: { color: theme.text, fontWeight: '700' },
  bubbleRow: { flexDirection: 'row' },
  left: { justifyContent: 'flex-start' },
  right: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '86%', borderRadius: radius.lg, padding: space.md },
  userBubble: { backgroundColor: theme.blue },
  botBubble: { backgroundColor: theme.s1, borderWidth: 1, borderColor: theme.s3 },
  thinking: { flexDirection: 'row', alignItems: 'center' },
  bubbleText: { color: theme.text, fontSize: font.base, lineHeight: 21 },
  // The web's checkbox rows.
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  box: {
    width: 20, height: 20, borderRadius: radius.sm - 2,
    borderWidth: 1, borderColor: theme.s3, backgroundColor: theme.s2,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: theme.blue, borderColor: theme.blue },
  tick: { color: '#08131F', fontSize: 13, fontWeight: '900', lineHeight: 16 },
  toggleLabel: { color: theme.textDim, fontSize: font.sm },
  toggleSub: { color: theme.textFaint },
  delegateRow: { paddingHorizontal: space.md, paddingBottom: space.md, backgroundColor: theme.bg },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: space.md,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.s3,
    backgroundColor: theme.bg,
  },
  input: {
    flex: 1,
    backgroundColor: theme.s2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.s3,
    color: theme.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.base,
    maxHeight: 120,
  },
  sendBtn: {
    color: theme.blue,
    fontSize: font.base,
    fontWeight: '800',
    padding: space.md,
  },
  // CC-ATT — the chip sits directly above the composer, like the web's.
  attachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: theme.s2,
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.md,
  },
  attachGlyph: { fontSize: font.base },
  attachLabel: { flex: 1, color: theme.text, fontSize: font.sm },
  attachReading: { color: theme.textDim, fontSize: font.sm },
  attachRemove: {
    color: theme.textDim,
    fontSize: font.base,
    fontWeight: '800',
    paddingHorizontal: space.sm,
  },
  attachBtn: { paddingVertical: space.md, paddingHorizontal: space.xs },
  attachBtnText: { fontSize: font.lg },
})
