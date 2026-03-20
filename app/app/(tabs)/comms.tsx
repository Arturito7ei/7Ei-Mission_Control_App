import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, RefreshControl, Alert } from 'react-native'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useStore } from '../../store'
import { api, GmailThread, Message } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { AgentAvatar } from '../../components/AgentAvatar'
import { EmptyState } from '../../components/EmptyState'

type Channel = 'inbox' | 'gmail' | 'telegram'

export default function CommsScreen() {
  const { currentOrg, agents } = useStore()
  const [channel, setChannel] = useState<Channel>('inbox')
  const [messages, setMessages] = useState<Message[]>([])
  const [gmailThreads, setGmailThreads] = useState<any[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [compose, setCompose] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const scrollRef = useRef<FlatList>(null)

  const loadInbox = useCallback(async () => {
    if (!currentOrg) return
    try {
      const { messages: list } = await api.comms.inbox(currentOrg.id)
      setMessages(list)
    } catch (e) { console.error(e) }
  }, [currentOrg])

  useEffect(() => { loadInbox() }, [loadInbox])
  const onRefresh = async () => { setRefreshing(true); await loadInbox(); setRefreshing(false) }

  const handleSend = async () => {
    if (!composeText.trim() || !currentOrg || !selectedAgent) return
    try {
      await api.comms.sendInternal(currentOrg.id, selectedAgent, composeText.trim())
      setComposeText('')
      setCompose(false)
      await loadInbox()
    } catch (e: any) { Alert.alert('Error', e.message) }
  }

  const agentMap = new Map(agents.map(a => [a.id, a]))

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Channel tabs */}
      <View style={styles.channelRow}>
        {(['inbox', 'gmail', 'telegram'] as Channel[]).map(ch => (
          <TouchableOpacity key={ch} style={[styles.channelBtn, channel === ch && styles.channelBtnActive]} onPress={() => setChannel(ch)}>
            <Text style={styles.channelIcon}>{ch === 'inbox' ? '📬' : ch === 'gmail' ? '📧' : '✈️'}</Text>
            <Text style={[styles.channelText, channel === ch && styles.channelTextActive]}>{ch.charAt(0).toUpperCase() + ch.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Inbox */}
      {channel === 'inbox' && (
        <FlatList
          ref={scrollRef}
          data={messages}
          keyExtractor={m => m.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
          ListEmptyComponent={<EmptyState emoji="📬" title="No messages" subtitle="Send a message to an agent to see it here" />}
          renderItem={({ item: msg }) => {
            const agent = agentMap.get(msg.agentId)
            return (
              <Card style={styles.msgCard}>
                <View style={styles.msgRow}>
                  {agent && <AgentAvatar emoji={agent.avatarEmoji} size={36} status={agent.status} />}
                  <View style={styles.msgContent}>
                    <View style={styles.msgHeader}>
                      <Text style={styles.msgAgent}>{msg.agentName ?? agent?.name ?? 'Unknown'}</Text>
                      <Text style={styles.msgRole}>{msg.role === 'user' ? '👤 You' : '🤖 Agent'}</Text>
                    </View>
                    <Text style={styles.msgText} numberOfLines={3}>{msg.content}</Text>
                  </View>
                </View>
              </Card>
            )
          }}
        />
      )}

      {/* Gmail */}
      {channel === 'gmail' && (
        <View style={styles.integrationBanner}>
          <Text style={styles.integrationIcon}>📧</Text>
          <Text style={styles.integrationTitle}>Gmail Integration</Text>
          <Text style={styles.integrationSub}>Connect your Google account in Settings to read and send emails directly from Mission Control. Arturito can draft and send replies on your behalf.</Text>
        </View>
      )}

      {/* Telegram */}
      {channel === 'telegram' && (
        <View style={styles.integrationBanner}>
          <Text style={styles.integrationIcon}>✈️</Text>
          <Text style={styles.integrationTitle}>Telegram Bot</Text>
          <Text style={styles.integrationSub}>Register your Telegram bot token in Settings. Once connected, messages sent to your bot will appear in this inbox, and agents can reply via Telegram.</Text>
        </View>
      )}

      {/* Compose FAB */}
      {channel === 'inbox' && !compose && (
        <TouchableOpacity style={styles.fab} onPress={() => { setCompose(true); setSelectedAgent(agents[0]?.id ?? '') }}>
          <Text style={styles.fabText}>✍️</Text>
        </TouchableOpacity>
      )}

      {/* Compose sheet */}
      {compose && (
        <View style={styles.composeSheet}>
          <View style={styles.composeHeader}>
            <Text style={styles.composeTitle}>New Message</Text>
            <TouchableOpacity onPress={() => setCompose(false)}><Text style={styles.composeClose}>×</Text></TouchableOpacity>
          </View>
          <Text style={styles.fieldLabel}>To Agent</Text>
          <View style={styles.agentPickerRow}>
            {agents.map(a => (
              <TouchableOpacity key={a.id} style={[styles.agentPill, selectedAgent === a.id && styles.agentPillActive]} onPress={() => setSelectedAgent(a.id)}>
                <Text style={styles.agentPillEmoji}>{a.avatarEmoji}</Text>
                <Text style={[styles.agentPillName, selectedAgent === a.id && styles.agentPillNameActive]}>{a.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={styles.composeInput}
            value={composeText}
            onChangeText={setComposeText}
            placeholder="Write your message..."
            placeholderTextColor={Colors.textMuted}
            multiline
            autoFocus
          />
          <TouchableOpacity style={[styles.sendBtn, !composeText.trim() && styles.sendBtnDisabled]} onPress={handleSend} disabled={!composeText.trim()}>
            <Text style={styles.sendBtnText}>Send Message</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  channelRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: Colors.border },
  channelBtn: { flex: 1, paddingVertical: Space.md, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: Space.xs },
  channelBtnActive: { borderBottomWidth: 2, borderBottomColor: Colors.accent },
  channelIcon: { fontSize: 16 },
  channelText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '500' },
  channelTextActive: { color: Colors.accent, fontWeight: '700' },
  list: { padding: Space.lg, gap: Space.sm },
  msgCard: { padding: Space.md },
  msgRow: { flexDirection: 'row', gap: Space.md, alignItems: 'flex-start' },
  msgContent: { flex: 1 },
  msgHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  msgAgent: { fontSize: 14, fontWeight: '600', color: Colors.text },
  msgRole: { fontSize: 11, color: Colors.textMuted },
  msgText: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  integrationBanner: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xxl, gap: Space.md },
  integrationIcon: { fontSize: 56 },
  integrationTitle: { fontSize: 22, fontWeight: '700', color: Colors.text },
  integrationSub: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  fabText: { fontSize: 22 },
  composeSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border, padding: Space.lg, gap: Space.md, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl },
  composeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  composeTitle: { fontSize: 17, fontWeight: '700', color: Colors.text },
  composeClose: { fontSize: 24, color: Colors.textSecondary },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  agentPickerRow: { flexDirection: 'row', gap: Space.sm, flexWrap: 'wrap' },
  agentPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.surfaceHigh, paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.border },
  agentPillActive: { borderColor: Colors.accent, backgroundColor: Colors.accentDim },
  agentPillEmoji: { fontSize: 14 },
  agentPillName: { fontSize: 13, color: Colors.textSecondary },
  agentPillNameActive: { color: Colors.accent, fontWeight: '600' },
  composeInput: { backgroundColor: Colors.surfaceHigh, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  sendBtn: { backgroundColor: Colors.accent, padding: Space.md, borderRadius: Radius.md, alignItems: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { fontSize: 15, fontWeight: '700', color: '#000' },
})
