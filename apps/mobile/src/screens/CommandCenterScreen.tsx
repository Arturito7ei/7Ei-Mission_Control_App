// Command Center — text chat to Arturita (the conversational front door).
// POST /api/orgs/:orgId/arturita/converse → renders the reply + a "via" chip
// (which provider/model answered, or that it was delegated to a task). This is the
// P0 remote-control surface: talk to your office from your phone.
//
// CC-ATT (web #285, mirrored) — the operator can attach a document to a turn and
// have Arturita answer from its contents. Same two-step contract as the web
// (extract on pick → send the text with the turn); the decisions live in
// ../attach, which is tested against the web's own module.

import React, { useCallback, useRef, useState } from 'react'
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
// TYPE-only: erased at compile time, so it keeps expo-document-picker's
// requireNativeModule('ExpoDocumentPicker') OUT of the boot path. The value is
// pulled in lazily at the tap — see getDocumentPicker below.
import type * as DocumentPickerNS from 'expo-document-picker'
import { Api } from '../api'
import { useAuth } from '../auth'
import { attachmentChipLabel, canSendTurn, rejectAttachment, toConverseAttachment, type AttachedDoc } from '../attach'
import { lazyNativeModule } from '../nativeModule'
import { font, radius, space, theme } from '../theme'
import { Banner, Chip } from '../ui'

// Resolved on the first attach tap, never at import. A host without the picker
// costs the operator the attach button, not the app.
const getDocumentPicker = lazyNativeModule(
  'expo-document-picker',
  () => require('expo-document-picker') as typeof DocumentPickerNS,
)

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
  const [notice, setNotice] = useState<string | null>(null)
  const scroller = useRef<ScrollView>(null)

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
        setNotice(
          `“${file.name}” is long, so I've attached the first part of it. I'll tell you if an answer needs the rest.`,
        )
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

  const send = useCallback(async () => {
    const text = input.trim()
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
      setMessages((cur) => [...cur, { role: 'assistant', content: reply, via }])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to send.')
    } finally {
      setBusy(false)
      requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }))
    }
  }, [apiUrl, getToken, orgId, input, messages, attachment, attaching, busy])

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={s.thread}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? (
          <View style={s.hello}>
            <Text style={s.helloTitle}>Talk to Arturita</Text>
            <Text style={s.helloText}>
              Ask a question or give an instruction. Simple questions get answered here; work gets
              delegated into a task you can track.
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
      </ScrollView>

      {error ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {notice ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <Banner kind="info">{notice}</Banner>
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
          onPress={busy ? undefined : send}
          style={[
            s.sendBtn,
            !canSendTurn({ typed: input, attachment, busy: busy || attaching }) && { opacity: 0.4 },
          ]}
        >
          Send
        </Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  thread: { padding: space.lg, gap: space.md },
  hello: { padding: space.lg, marginTop: space.xl },
  helloTitle: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  helloText: { color: theme.textDim, fontSize: font.base, marginTop: space.sm, lineHeight: 21 },
  bubbleRow: { flexDirection: 'row' },
  left: { justifyContent: 'flex-start' },
  right: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '86%', borderRadius: radius.lg, padding: space.md },
  userBubble: { backgroundColor: theme.blue },
  botBubble: { backgroundColor: theme.s1, borderWidth: 1, borderColor: theme.s3 },
  thinking: { flexDirection: 'row', alignItems: 'center' },
  bubbleText: { color: theme.text, fontSize: font.base, lineHeight: 21 },
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
