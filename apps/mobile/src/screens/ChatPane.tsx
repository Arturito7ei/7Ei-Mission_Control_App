// MCC-1 — Chat: talk to any agent from the phone, replies included.
//
// MIRRORS the web's ChatPanel over the SAME org-scoped routes
// (GET/POST /api/orgs/:orgId/agents/:agentId/chat). One contract, two runtimes:
// an INTERNAL agent's reply is in the POST response; an EXTERNAL agent's reply
// arrives later through its poll loop, so this pane keeps polling the GET.
// Merging/awaiting/preview logic is ../chat.ts — the parity-pinned copy of
// web/lib/chat.logic.ts, so both clients converge on the same thread.
//
// Layout: an agent strip (horizontal chips) over the thread over the composer,
// inside a KeyboardAvoidingView — the full-screen `flex: 1` shell shape, the
// same pattern CommandCenterScreen uses (and the AAD-2 keyboard lesson says a
// composer the keyboard can cover is a bug, not a nit).
// Colorblind rule: user/assistant sides read from ALIGNMENT + label, never hue.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Api, type Agent } from '../api'
import { useAuth } from '../auth'
import { awaitingReply, chatSendError, mergeThread, threadPreview, type ChatMsgLite } from '../chat'
import { font, space, theme } from '../theme'
import { Banner, Empty, Loading } from '../ui'

const POLL_MS = 4000

export default function ChatPane() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [threads, setThreads] = useState<Record<string, ChatMsgLite[]>>({})
  const [external, setExternal] = useState<Record<string, boolean>>({})
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<ScrollView>(null)

  // Roster once; select the first agent so the pane opens on a real thread.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const token = await getToken()
        if (!token || !orgId) return
        const list = await Api.agents(apiUrl, token, orgId)
        if (!alive) return
        setAgents(list)
        setSel((s) => s ?? list[0]?.id ?? null)
      } catch (e: any) {
        if (alive) { setAgents([]); setError(e?.message ?? 'Failed to load agents.') }
      }
    })()
    return () => { alive = false }
  }, [apiUrl, getToken, orgId])

  const load = useCallback(async (agentId: string) => {
    try {
      const token = await getToken()
      if (!token || !orgId) return
      const r = await Api.agentChat(apiUrl, token, orgId, agentId)
      setThreads((t) => ({ ...t, [agentId]: mergeThread(t[agentId] ?? [], r.messages) }))
      setExternal((x) => ({ ...x, [agentId]: r.agent.external }))
      setError(null)
    } catch (e: any) { setError(e?.message ?? 'Failed to load the thread.') }
  }, [apiUrl, getToken, orgId])

  // Poll the selected thread — external replies arrive out-of-band.
  useEffect(() => {
    if (!sel) return
    load(sel)
    const t = setInterval(() => load(sel), POLL_MS)
    return () => clearInterval(t)
  }, [sel, load])

  const msgs = sel ? threads[sel] ?? [] : []
  useEffect(() => { scroller.current?.scrollToEnd({ animated: false }) }, [msgs.length, sel])

  const send = useCallback(async () => {
    if (!sel || sending) return
    if (!input.trim()) return // an empty composer is a no-op, not an error
    const problem = chatSendError(input)
    if (problem) { setError(problem); return }
    const content = input.trim()
    setSending(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token || !orgId) return
      const r = await Api.sendAgentChat(apiUrl, token, orgId, sel, content)
      setInput('')
      setThreads((t) => ({
        ...t,
        [sel]: mergeThread(t[sel] ?? [], [r.message, ...(r.reply ? [r.reply] : [])]),
      }))
      // A governance/budget refusal is a NOTICE, not a reply — the server does
      // not persist it into the thread, so surface it here.
      if (r.notice) setError(String(r.notice))
    } catch (e: any) { setError(e?.message ?? 'Send failed.') }
    finally { setSending(false) }
  }, [sel, sending, input, apiUrl, getToken, orgId])

  if (agents === null) return <Loading text="Loading agents…" />
  if (agents.length === 0) return <Empty text="No agents yet — add one from the Agents tab." />

  const selAgent = agents.find((a) => a.id === sel) ?? null
  const waiting = awaitingReply(msgs) && (external[sel ?? ''] ?? false)

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* ── Agent strip ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.strip} contentContainerStyle={s.stripInner}>
        {agents.map((a) => {
          const active = a.id === sel
          return (
            <Pressable key={a.id} onPress={() => setSel(a.id)}
              accessibilityRole="tab" accessibilityState={{ selected: active }}
              style={({ pressed }) => [s.agentChip, active && s.agentChipOn, pressed && { opacity: 0.7 }]}>
              <Text style={[s.agentChipText, active && s.agentChipTextOn]} numberOfLines={1}>
                {a.avatarEmoji ? `${a.avatarEmoji} ` : ''}{a.name}
              </Text>
              {!!threadPreview(threads[a.id] ?? [], 24) && (
                <Text style={s.agentChipPreview} numberOfLines={1}>{threadPreview(threads[a.id] ?? [], 24)}</Text>
              )}
            </Pressable>
          )
        })}
      </ScrollView>

      {/* ── Thread ── */}
      <ScrollView ref={scroller} style={s.thread} contentContainerStyle={{ padding: space.lg }}>
        {msgs.length === 0 && <Empty text={selAgent ? `No messages with ${selAgent.name} yet — say hello.` : 'Select an agent.'} />}
        {msgs.map((m) => {
          const mine = m.role === 'user'
          return (
            <View key={m.id} style={[s.bubbleRow, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
              <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
                <Text style={s.bubbleMeta}>
                  {mine ? 'You' : selAgent?.name ?? 'Agent'} · {new Date(m.createdAt as any).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
                <Text style={s.bubbleText}>{m.content}</Text>
              </View>
            </View>
          )
        })}
        {waiting && selAgent && (
          <Text style={s.waiting}>⏳ Delivered — awaiting {selAgent.name}’s reply…</Text>
        )}
      </ScrollView>

      {error && <View style={{ paddingHorizontal: space.lg }}><Banner kind="error">{error}</Banner></View>}

      {/* ── Composer ── */}
      <View style={s.composer}>
        <TextInput
          style={s.inputBox}
          value={input}
          onChangeText={setInput}
          placeholder={selAgent ? `Message ${selAgent.name}…` : 'Message…'}
          placeholderTextColor={theme.textDim}
          multiline
          accessibilityLabel={selAgent ? `Message ${selAgent.name}` : 'Message'}
        />
        <Pressable
          onPress={send}
          disabled={sending || !input.trim() || !sel}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={({ pressed }) => [s.sendBtn, (sending || !input.trim()) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
        >
          <Text style={s.sendBtnText}>{sending ? '…' : '➤'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  strip: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: theme.s3 },
  stripInner: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  agentChip: {
    paddingVertical: space.sm, paddingHorizontal: space.md,
    borderRadius: 10, borderWidth: 1, borderColor: theme.s3, backgroundColor: theme.s1,
    maxWidth: 180,
  },
  agentChipOn: { borderColor: theme.blue, backgroundColor: theme.s2 },
  agentChipText: { color: theme.textDim, fontSize: font.base, fontWeight: '600' },
  agentChipTextOn: { color: theme.text, fontWeight: '800' },
  agentChipPreview: { color: theme.textDim, fontSize: font.sm },
  thread: { flex: 1 },
  bubbleRow: { flexDirection: 'row', marginBottom: space.sm },
  bubble: { maxWidth: '80%', borderRadius: 12, paddingVertical: space.sm, paddingHorizontal: space.md, borderWidth: 1 },
  bubbleMine: { backgroundColor: theme.s2, borderColor: theme.blue },
  bubbleTheirs: { backgroundColor: theme.s1, borderColor: theme.s3 },
  bubbleMeta: { color: theme.textDim, fontSize: font.sm, marginBottom: 2 },
  bubbleText: { color: theme.text, fontSize: font.base, lineHeight: 20 },
  waiting: { color: theme.textDim, fontSize: font.sm, paddingVertical: space.sm },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderTopWidth: 1, borderTopColor: theme.s3, backgroundColor: theme.bg,
  },
  inputBox: {
    flex: 1, minHeight: 40, maxHeight: 120,
    borderWidth: 1, borderColor: theme.s3, borderRadius: 10,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    color: theme.text, fontSize: font.base, backgroundColor: theme.s1,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.blue,
  },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '800' },
})
