import {
  View, Text, TextInput, FlatList,
  StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native'
import { useState, useCallback, useRef } from 'react'
import { useRouter, Stack } from 'expo-router'
import { useStore } from '../../store'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { AgentAvatar } from '../../components/AgentAvatar'
import { StatusBadge } from '../../components/StatusBadge'
import { PriorityBadge } from '../../components/PriorityBadge'
import { ThemedText } from '../../components/ThemedText'
import { EmptyState } from '../../components/EmptyState'

type ResultKind = 'agent' | 'task' | 'project' | 'skill'

interface SearchResult {
  id: string
  kind: ResultKind
  title: string
  subtitle: string
  emoji?: string
  status?: string
  priority?: string
  path: string
}

export default function GlobalSearchScreen() {
  const router = useRouter()
  const { agents, tasks, projects, skills } = useStore()
  const { theme } = useTheme()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const inputRef = useRef<TextInput>(null)

  const KIND_ICON: Record<ResultKind, string> = {
    agent: '🤖', task: '📋', project: '📁', skill: '⚡',
  }

  const search = useCallback((q: string) => {
    const lower = q.toLowerCase().trim()
    if (!lower) { setResults([]); setSearched(false); return }

    const out: SearchResult[] = []

    // Agents
    agents
      .filter(a =>
        a.name.toLowerCase().includes(lower) ||
        a.role.toLowerCase().includes(lower) ||
        (a.personality ?? '').toLowerCase().includes(lower)
      )
      .slice(0, 5)
      .forEach(a => out.push({
        id: a.id, kind: 'agent',
        title: `${a.avatarEmoji} ${a.name}`,
        subtitle: a.role, emoji: a.avatarEmoji,
        status: a.status, path: `/agents/${a.id}`,
      }))

    // Tasks
    tasks
      .filter(t =>
        t.title.toLowerCase().includes(lower) ||
        (t.input ?? '').toLowerCase().includes(lower) ||
        (t.output ?? '').toLowerCase().includes(lower)
      )
      .slice(0, 8)
      .forEach(t => {
        const agent = agents.find(a => a.id === t.agentId)
        out.push({
          id: t.id, kind: 'task',
          title: t.title,
          subtitle: agent ? `${agent.avatarEmoji} ${agent.name}` : 'Unassigned',
          status: t.status, priority: t.priority,
          path: `/tasks/${t.id}`,
        })
      })

    // Projects
    projects
      .filter(p =>
        p.name.toLowerCase().includes(lower) ||
        (p.description ?? '').toLowerCase().includes(lower)
      )
      .slice(0, 4)
      .forEach(p => out.push({
        id: p.id, kind: 'project',
        title: `📁 ${p.name}`,
        subtitle: p.description ?? 'No description',
        path: `/projects/${p.id}`,
      }))

    // Skills
    skills
      .filter(sk =>
        sk.name.toLowerCase().includes(lower) ||
        sk.domain.toLowerCase().includes(lower) ||
        (sk.description ?? '').toLowerCase().includes(lower)
      )
      .slice(0, 4)
      .forEach(sk => out.push({
        id: sk.id, kind: 'skill',
        title: `⚡ ${sk.name}`,
        subtitle: sk.domain,
        path: `/skills/${sk.id}`,
      }))

    setResults(out)
    setSearched(true)
  }, [agents, tasks, projects, skills])

  const handleChange = (text: string) => {
    setQuery(text)
    search(text)
  }

  const handleClear = () => {
    setQuery('')
    setResults([])
    setSearched(false)
    inputRef.current?.focus()
  }

  const handleNavigate = (result: SearchResult) => {
    router.push(result.path as any)
  }

  const KIND_COLOR: Record<ResultKind, string> = {
    agent:   theme.accent,
    task:    theme.textSecondary,
    project: theme.statusDone,
    skill:   theme.statusWarning,
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: 'Search', headerShown: false }} />

      {/* Search header */}
      <View style={[styles.searchHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={[styles.inputRow, { backgroundColor: theme.surfaceHigh, borderColor: theme.borderLight }]}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: theme.text }]}
            value={query}
            onChangeText={handleChange}
            placeholder="Search agents, tasks, projects, skills…"
            placeholderTextColor={theme.textMuted}
            autoFocus
            returnKeyType="search"
            autoCapitalize="none"
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={handleClear}>
              <Text style={[styles.clearBtn, { color: theme.textMuted }]}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={() => router.back()} style={styles.cancelBtn}>
          <ThemedText variant="accent">Cancel</ThemedText>
        </TouchableOpacity>
      </View>

      {/* Results */}
      <FlatList
        data={results}
        keyExtractor={r => r.id + r.kind}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          results.length > 0 ? (
            <ThemedText variant="muted" style={styles.resultCount}>
              {results.length} result{results.length !== 1 ? 's' : ''}
            </ThemedText>
          ) : null
        }
        ListEmptyComponent={
          searched && query.length > 0
            ? <EmptyState emoji="🔍" title="No results" subtitle={`Nothing matched "${query}"`} />
            : (
              <View style={styles.suggestBox}>
                <ThemedText variant="label" style={{ marginBottom: Space.md }}>Quick access</ThemedText>
                {[
                  { label: 'Agents', path: '/(tabs)/agents', emoji: '🤖' },
                  { label: 'Tasks',  path: '/(tabs)/tasks',  emoji: '📋' },
                  { label: 'Projects', path: '/projects',    emoji: '📁' },
                  { label: 'Skills', path: '/skills',        emoji: '⚡' },
                ].map(link => (
                  <TouchableOpacity
                    key={link.path}
                    style={[styles.quickLink, { backgroundColor: theme.surface, borderColor: theme.border }]}
                    onPress={() => router.push(link.path as any)}
                  >
                    <Text style={{ fontSize: 20 }}>{link.emoji}</Text>
                    <ThemedText variant="body">{link.label}</ThemedText>
                    <ThemedText variant="muted">›</ThemedText>
                  </TouchableOpacity>
                ))}
              </View>
            )
        }
        renderItem={({ item }) => (
          <TouchableOpacity onPress={() => handleNavigate(item)}>
            <Card style={styles.result}>
              <View style={[styles.kindDot, { backgroundColor: KIND_COLOR[item.kind] + '20', borderColor: KIND_COLOR[item.kind] + '40' }]}>
                <Text style={{ fontSize: 11, fontWeight: FontWeight.bold, color: KIND_COLOR[item.kind] }}>
                  {item.kind.toUpperCase()}
                </Text>
              </View>
              <View style={styles.resultInfo}>
                <ThemedText variant="body" style={{ fontWeight: FontWeight.medium }} numberOfLines={1}>
                  {item.title}
                </ThemedText>
                <ThemedText variant="muted" style={{ fontSize: FontSize.xs }} numberOfLines={1}>
                  {item.subtitle}
                </ThemedText>
              </View>
              <View style={styles.resultBadges}>
                {item.status   && <StatusBadge status={item.status} />}
                {item.priority && <PriorityBadge priority={item.priority} />}
              </View>
            </Card>
          </TouchableOpacity>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchHeader: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, padding: Space.md, borderBottomWidth: 0.5, paddingTop: 52 },
  inputRow: { flex: 1, flexDirection: 'row', alignItems: 'center', borderWidth: 0.5, borderRadius: Radius.xl, paddingHorizontal: Space.md, height: 42, gap: Space.sm },
  searchIcon: { fontSize: 16 },
  input: { flex: 1, fontSize: FontSize.base },
  clearBtn: { fontSize: FontSize.lg, paddingHorizontal: 4 },
  cancelBtn: { paddingHorizontal: Space.sm },
  list: { padding: Space.lg, gap: Space.sm, paddingBottom: 48 },
  resultCount: { marginBottom: Space.sm, fontSize: FontSize.sm },
  result: { flexDirection: 'row', alignItems: 'center', padding: Space.md, gap: Space.sm },
  kindDot: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, borderWidth: 0.5, alignSelf: 'flex-start' },
  resultInfo: { flex: 1 },
  resultBadges: { flexDirection: 'row', gap: Space.xs, flexShrink: 0 },
  suggestBox: { padding: Space.sm, gap: Space.sm },
  quickLink: { flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.md, borderRadius: Radius.md, borderWidth: 0.5, justifyContent: 'space-between' },
})
