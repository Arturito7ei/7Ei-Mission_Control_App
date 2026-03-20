import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  TextInput, Alert, RefreshControl, ScrollView,
} from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { Stack } from 'expo-router'
import { useStore } from '../../store'
import { api, JiraIssue } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { PriorityBadge } from '../../components/PriorityBadge'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'

const STATUS_COLORS: Record<string, string> = {
  'To Do': Colors.textMuted, 'In Progress': Colors.info,
  'Done': Colors.success, 'Blocked': Colors.error, 'In Review': Colors.warning,
}

type ViewMode = 'issues' | 'connect' | 'create'

export default function JiraScreen() {
  const { currentOrg, agents } = useStore()
  const [mode, setMode] = useState<ViewMode>('issues')
  const [connected, setConnected] = useState(false)
  const [domain, setDomain] = useState('')
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [connectForm, setConnectForm] = useState({ domain: '', email: '', apiToken: '', projectKey: 'O7MC' })
  const [createForm, setCreateForm] = useState({ summary: '', description: '', priority: 'Medium', agentId: '' })
  const [creating, setCreating] = useState(false)

  const checkStatus = useCallback(async () => {
    if (!currentOrg) return
    try {
      const status = await api.jira.status(currentOrg.id)
      setConnected(status.connected)
      if (status.domain) setDomain(status.domain)
    } catch {}
  }, [currentOrg])

  const loadIssues = useCallback(async () => {
    if (!currentOrg || !connected) return
    try {
      const { issues: list } = await api.jira.issues(currentOrg.id)
      setIssues(list)
    } catch (e: any) { Alert.alert('Error', e.message) }
  }, [currentOrg, connected])

  useEffect(() => { checkStatus() }, [checkStatus])
  useEffect(() => { if (connected) loadIssues() }, [connected, loadIssues])
  const onRefresh = async () => { setRefreshing(true); await loadIssues(); setRefreshing(false) }

  const handleConnect = async () => {
    if (!currentOrg || !connectForm.domain || !connectForm.email || !connectForm.apiToken) { Alert.alert('Required', 'All fields required'); return }
    setConnecting(true)
    try {
      const result = await api.jira.connect(currentOrg.id, { domain: connectForm.domain, email: connectForm.email, apiToken: connectForm.apiToken, defaultProjectKey: connectForm.projectKey })
      setConnected(true); setDomain(connectForm.domain); setMode('issues')
      Alert.alert('Connected', `Signed in as ${result.jiraUser}`)
    } catch (e: any) { Alert.alert('Connection failed', e.message) }
    finally { setConnecting(false) }
  }

  const handleSync = async () => {
    if (!currentOrg || agents.length === 0) { Alert.alert('Required', 'Add an agent first'); return }
    setSyncing(true)
    try {
      const { synced } = await api.jira.sync(currentOrg.id, agents[0].id)
      await loadIssues()
      Alert.alert('Synced', `${synced} issues pulled from Jira into Tasks`)
    } catch (e: any) { Alert.alert('Sync failed', e.message) }
    finally { setSyncing(false) }
  }

  const handleCreate = async () => {
    if (!currentOrg || !createForm.summary) { Alert.alert('Required', 'Summary required'); return }
    setCreating(true)
    try {
      const { issue } = await api.jira.createIssue(currentOrg.id, { summary: createForm.summary, description: createForm.description || undefined, priority: createForm.priority, agentId: createForm.agentId || undefined })
      Alert.alert('Created', `${issue.key} created in Jira`)
      setMode('issues'); setCreateForm({ summary: '', description: '', priority: 'Medium', agentId: '' })
      await loadIssues()
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setCreating(false) }
  }

  const handleDisconnect = () => {
    Alert.alert('Disconnect Jira?', 'This removes the integration.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: async () => { await api.jira.disconnect(currentOrg!.id); setConnected(false); setIssues([]) } },
    ])
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Jira — O7MC' }} />
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Jira</Text>
          <Text style={[styles.domainTag, !connected && { color: Colors.error }]}>{connected ? domain : 'Not connected'}</Text>
        </View>
        <View style={styles.headerActions}>
          {connected && (
            <>
              <TouchableOpacity style={styles.iconBtn} onPress={handleSync} disabled={syncing}>
                <Text style={styles.iconBtnText}>{syncing ? '⏳' : '↻'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconBtn} onPress={() => setMode('create')}>
                <Text style={styles.iconBtnText}>+</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity style={styles.iconBtn} onPress={() => setMode(mode === 'connect' ? 'issues' : 'connect')}>
            <Text style={styles.iconBtnText}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>

      {mode === 'connect' && (
        <ScrollView style={styles.form} contentContainerStyle={styles.formContent}>
          <Text style={styles.formTitle}>{connected ? 'Jira Connection' : 'Connect to Jira'}</Text>
          {connected ? (
            <Button label="Disconnect" onPress={handleDisconnect} variant="danger" />
          ) : (
            <>
              {([{ key: 'domain', label: 'Atlassian Domain', placeholder: 'your-org' },
                { key: 'email', label: 'Email', placeholder: 'you@company.com' },
                { key: 'apiToken', label: 'API Token', placeholder: 'From id.atlassian.com/manage/api-tokens', secure: true },
                { key: 'projectKey', label: 'Default Project Key', placeholder: 'O7MC' },
              ] as any[]).map((f) => (
                <View key={f.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  <TextInput style={styles.input} value={(connectForm as any)[f.key]} onChangeText={v => setConnectForm(c => ({ ...c, [f.key]: v }))} placeholder={f.placeholder} placeholderTextColor={Colors.textMuted} secureTextEntry={f.secure} autoCapitalize="none" />
                </View>
              ))}
              <Button label="Connect to Jira" onPress={handleConnect} loading={connecting} />
            </>
          )}
        </ScrollView>
      )}

      {mode === 'create' && (
        <ScrollView style={styles.form} contentContainerStyle={styles.formContent}>
          <Text style={styles.formTitle}>Create Jira Issue</Text>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Summary *</Text>
            <TextInput style={styles.input} value={createForm.summary} onChangeText={v => setCreateForm(c => ({ ...c, summary: v }))} placeholder="What needs to be done?" placeholderTextColor={Colors.textMuted} />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput style={[styles.input, styles.multiInput]} value={createForm.description} onChangeText={v => setCreateForm(c => ({ ...c, description: v }))} placeholder="Details..." placeholderTextColor={Colors.textMuted} multiline />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Priority</Text>
            <View style={styles.chipRow}>
              {['Lowest', 'Low', 'Medium', 'High', 'Highest'].map(p => (
                <TouchableOpacity key={p} style={[styles.chip, createForm.priority === p && styles.chipActive]} onPress={() => setCreateForm(c => ({ ...c, priority: p }))}>
                  <Text style={[styles.chipText, createForm.priority === p && styles.chipTextActive]}>{p}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={styles.btnRow}>
            <Button label="Cancel" onPress={() => setMode('issues')} variant="secondary" style={{ flex: 1 }} />
            <Button label="Create Issue" onPress={handleCreate} loading={creating} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      )}

      {mode === 'issues' && (
        !connected ? (
          <EmptyState emoji="🔗" title="Connect Jira" subtitle="Tap ⚙️ to connect your Atlassian account and sync issues from project O7MC" />
        ) : (
          <FlatList
            data={issues}
            keyExtractor={i => i.id}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
            ListEmptyComponent={<EmptyState emoji="📋" title="No issues" subtitle="Tap ↻ to sync from Jira or + to create one" />}
            renderItem={({ item: issue }) => (
              <Card style={styles.issueCard}>
                <View style={styles.issueHeader}>
                  <Text style={styles.issueKey}>{issue.key}</Text>
                  <View style={[styles.statusTag, { backgroundColor: (STATUS_COLORS[issue.status ?? ''] ?? Colors.textMuted) + '22' }]}>
                    <Text style={[styles.statusText, { color: STATUS_COLORS[issue.status ?? ''] ?? Colors.textMuted }]}>{issue.status ?? 'Unknown'}</Text>
                  </View>
                </View>
                <Text style={styles.issueSummary} numberOfLines={2}>{issue.summary}</Text>
                <View style={styles.issueMeta}>
                  {issue.priority && <PriorityBadge priority={issue.priority.toLowerCase()} />}
                  {issue.assignee && <Text style={styles.assignee}>👤 {issue.assignee}</Text>}
                  {issue.issueType && <Text style={styles.issueType}>{issue.issueType}</Text>}
                </View>
              </Card>
            )}
          />
        )
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  headerTitle: { fontSize: 20, fontWeight: '800', color: Colors.text },
  domainTag: { fontSize: 12, color: Colors.textMuted, backgroundColor: Colors.surfaceHigh, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  headerActions: { flexDirection: 'row', gap: Space.xs },
  iconBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  iconBtnText: { fontSize: 16 },
  form: { flex: 1 },
  formContent: { padding: Space.lg, gap: Space.lg, paddingBottom: 48 },
  formTitle: { fontSize: 20, fontWeight: '700', color: Colors.text },
  field: { gap: Space.xs },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Space.md, color: Colors.text, fontSize: 15 },
  multiInput: { minHeight: 80, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  chip: { paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.xl, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.accentDim, borderColor: Colors.accent },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.accent, fontWeight: '700' },
  btnRow: { flexDirection: 'row', gap: Space.sm },
  list: { padding: Space.lg, gap: Space.sm },
  issueCard: { padding: Space.md, gap: Space.sm },
  issueHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  issueKey: { fontSize: 12, fontWeight: '700', color: Colors.accent, fontFamily: 'monospace' },
  statusTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  statusText: { fontSize: 11, fontWeight: '600' },
  issueSummary: { fontSize: 14, fontWeight: '600', color: Colors.text, lineHeight: 20 },
  issueMeta: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexWrap: 'wrap' },
  assignee: { fontSize: 12, color: Colors.textSecondary },
  issueType: { fontSize: 11, color: Colors.textMuted, backgroundColor: Colors.surfaceHigh, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
})
