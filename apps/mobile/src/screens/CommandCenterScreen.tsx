// Command Center — text chat to Arturita (the conversational front door).
// POST /api/orgs/:orgId/arturita/converse → renders the reply + a "via" chip
// (which provider/model answered, or that it was delegated to a task). This is the
// P0 remote-control surface: talk to your office from your phone.

import React, { useCallback, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import { font, radius, space, theme } from '../theme'
import { Banner, Chip } from '../ui'

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
  const scroller = useRef<ScrollView>(null)

  const send = useCallback(async () => {
    const text = input.trim()
    const token = getToken()
    if (!text || !token || !orgId) return
    setError(null)
    setInput('')
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setBusy(true)
    try {
      const r = await Api.converse(apiUrl, token, orgId, text, history)
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
  }, [apiUrl, getToken, orgId, input, messages])

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

      <View style={s.composer}>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message Arturita…"
          placeholderTextColor={theme.textFaint}
          multiline
          editable={!busy}
        />
        <Text
          accessibilityRole="button"
          onPress={busy ? undefined : send}
          style={[s.sendBtn, (!input.trim() || busy) && { opacity: 0.4 }]}
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
})
