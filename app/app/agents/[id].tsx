import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Alert } from 'react-native'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api, Message } from '../../lib/api'
import { createAgentStream } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { StatusBadge } from '../../components/StatusBadge'
import { AgentAvatar } from '../../components/AgentAvatar'

type Tab = 'chat' | 'info' | 'skills'

export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { agents, messages, setMessages, addMessage, appendToLastMessage, updateAgent, skills } = useStore()
  const agent = agents.find(a => a.id === id)
  const [tab, setTab] = useState<Tab>('chat')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const agentMsgs = messages[id ?? ''] ?? []

  const loadMessages = useCallback(async () => {
    if (!id) return
    const { messages: list } = await api.agents.messages(id)
    setMessages(id, list)
  }, [id])

  useEffect(() => {
    loadMessages()
    return () => { wsRef.current?.close() }
  }, [loadMessages])

  const sendMessage = async () => {
    if (!input.trim() || !agent || sending) return
    const text = input.trim()
    setInput('')
    setSending(true)

    const userMsg: Message = { id: Date.now().toString(), agentId: id!, role: 'user', content: text, createdAt: new Date().toISOString() }
    addMessage(id!, userMsg)

    try {
      // Try WebSocket stream first
      const ws = createAgentStream(id!)
      wsRef.current = ws

      ws.onopen = () => {
        const history = agentMsgs.slice(-10).map(m => ({ role: m.role, content: m.content }))
        ws.send(JSON.stringify({ input: text, history }))
      }

      let started = false
      ws.onmessage = (evt) => {
        const data = JSON.parse(evt.data)
        if (data.type === 'start') {
          const assistantMsg: Message = { id: data.taskId, agentId: id!, role: 'assistant', content: '', createdAt: new Date().toISOString() }
          addMessage(id!, assistantMsg)
          started = true
        } else if (data.type === 'token' && started) {
          appendToLastMessage(id!, data.data)
          scrollRef.current?.scrollToEnd({ animated: false })
        } else if (data.type === 'done') {
          setSending(false)
          ws.close()
        } else if (data.type === 'error') {
          setSending(false)
          ws.close()
        }
      }
      ws.onerror = async () => {
        // Fallback to REST
        ws.close()
        const history = agentMsgs.slice(-10).map(m => ({ role: m.role as any, content: m.content }))
        const result = await api.agents.chat(id!, text, history)
        const assistantMsg: Message = { id: result.taskId, agentId: id!, role: 'assistant', content: result.output, createdAt: new Date().toISOString() }
        addMessage(id!, assistantMsg)
        setSending(false)
      }
    } catch (e) {
      setSending(false)
    }
  }

  const handleDelete = () => {
    Alert.alert('Delete Agent', `Remove ${agent?.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await api.agents.delete(id!)
        router.back()
      }},
    ])
  }

  if (!agent) return null

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{
        title: agent.name,
        headerRight: () => (
          <TouchableOpacity onPress={() => router.push(`/agents/edit?id=${id}`)} style={{ marginRight: 8 }}>
            <Text style={{ color: Colors.accent, fontSize: 15 }}>Edit</Text>
          </TouchableOpacity>
        ),
      }} />

      {/* Agent header */}
      <View style={styles.agentHeader}>
        <AgentAvatar emoji={agent.avatarEmoji} size={56} status={agent.status} />
        <View style={styles.agentInfo}>
          <Text style={styles.agentName}>{agent.name}</Text>
          <Text style={styles.agentRole}>{agent.role}</Text>
          <View style={styles.metaRow}>
            <StatusBadge status={agent.status} />
            <Text style={styles.modelTag}>{agent.llmModel.split('-').slice(0, 2).join('-')}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
          <Text style={{ fontSize: 18 }}>🗑️</Text>
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {(['chat', 'info', 'skills'] as Tab[]).map(t => (
          <TouchableOpacity key={t} style={[styles.tabBtn, tab === t && styles.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t.charAt(0).toUpperCase() + t.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Chat */}
      {tab === 'chat' && (
        <>
          <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.messagesList} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
            {agentMsgs.length === 0 && (
              <View style={styles.welcomeBox}>
                <Text style={styles.welcomeEmoji}>{agent.avatarEmoji}</Text>
                <Text style={styles.welcomeText}>Hi, I'm {agent.name}. {agent.role}.{agent.personality ? '\n\n' + agent.personality.slice(0, 120) : ''}</Text>
              </View>
            )}
            {agentMsgs.map(msg => (
              <View key={msg.id} style={[styles.bubble, msg.role === 'user' ? styles.userBubble : styles.aiBubble]}>
                <Text style={[styles.bubbleText, msg.role === 'user' ? styles.userText : styles.aiText]}>
                  {msg.content || (sending && msg.role === 'assistant' ? '█' : '')}
                </Text>
              </View>
            ))}
            {sending && agentMsgs[agentMsgs.length - 1]?.role === 'user' && (
              <View style={styles.aiBubble}>
                <Text style={styles.aiText}>█</Text>
              </View>
            )}
          </ScrollView>
          <View style={styles.inputBar}>
            <TextInput
              style={styles.textInput}
              value={input}
              onChangeText={setInput}
              placeholder={`Message ${agent.name}...`}
              placeholderTextColor={Colors.textMuted}
              multiline
              maxLength={4000}
            />
            <TouchableOpacity style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]} onPress={sendMessage} disabled={!input.trim() || sending}>
              <Text style={styles.sendBtnText}>{sending ? '...' : '↑'}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Info */}
      {tab === 'info' && (
        <ScrollView style={styles.infoScroll} contentContainerStyle={styles.infoContent}>
          {[
            { label: 'Role', value: agent.role },
            { label: 'Type', value: agent.agentType },
            { label: 'LLM Model', value: agent.llmModel },
            { label: 'Status', value: agent.status },
            agent.personality ? { label: 'Personality', value: agent.personality } : null,
            agent.advisorPersona ? { label: 'Persona', value: agent.advisorPersona } : null,
          ].filter(Boolean).map((item: any) => (
            <Card key={item.label} style={styles.infoCard}>
              <Text style={styles.infoLabel}>{item.label}</Text>
              <Text style={styles.infoValue}>{item.value}</Text>
            </Card>
          ))}
        </ScrollView>
      )}

      {/* Skills */}
      {tab === 'skills' && (
        <ScrollView style={styles.infoScroll} contentContainerStyle={styles.infoContent}>
          {agent.skills.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>No skills assigned yet</Text>
              <Text style={styles.emptySub}>Go to the Skills tab to assign skills to this agent</Text>
            </View>
          ) : agent.skills.map(skill => (
            <Card key={skill} style={styles.skillChip}>
              <Text style={styles.skillName}>⚡ {skill}</Text>
            </Card>
          ))}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  agentHeader: { flexDirection: 'row', alignItems: 'center', padding: Space.lg, gap: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  agentInfo: { flex: 1 },
  agentName: { fontSize: 18, fontWeight: '700', color: Colors.text },
  agentRole: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  metaRow: { flexDirection: 'row', gap: Space.sm, marginTop: Space.xs, alignItems: 'center' },
  modelTag: { fontSize: 11, color: Colors.textMuted, backgroundColor: Colors.surfaceHigh, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  deleteBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.surfaceHigh, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  tabRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: Space.md, alignItems: 'center' },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: Colors.accent },
  tabText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '500' },
  tabTextActive: { color: Colors.accent, fontWeight: '700' },
  messages: { flex: 1 },
  messagesList: { padding: Space.lg, gap: Space.md, flexGrow: 1, justifyContent: 'flex-end' },
  welcomeBox: { alignItems: 'center', padding: Space.xl, gap: Space.md },
  welcomeEmoji: { fontSize: 48 },
  welcomeText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  bubble: { maxWidth: '85%', borderRadius: Radius.lg, padding: Space.md, paddingHorizontal: Space.lg },
  userBubble: { alignSelf: 'flex-end', backgroundColor: Colors.accent },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  userText: { color: '#000', fontWeight: '500' },
  aiText: { color: Colors.text },
  inputBar: { flexDirection: 'row', padding: Space.md, gap: Space.sm, borderTopWidth: 1, borderTopColor: Colors.border, backgroundColor: Colors.surface },
  textInput: { flex: 1, backgroundColor: Colors.surfaceHigh, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.lg, padding: Space.md, color: Colors.text, fontSize: 15, maxHeight: 120 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end' },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { fontSize: 18, fontWeight: '700', color: '#000' },
  infoScroll: { flex: 1 },
  infoContent: { padding: Space.lg, gap: Space.sm },
  infoCard: { gap: 4 },
  infoLabel: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { fontSize: 15, color: Colors.text, lineHeight: 22 },
  emptyBox: { padding: Space.xl, alignItems: 'center', gap: Space.sm },
  emptyText: { fontSize: 16, fontWeight: '600', color: Colors.text },
  emptySub: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center' },
  skillChip: { padding: Space.md },
  skillName: { fontSize: 14, color: Colors.text, fontWeight: '600' },
})
