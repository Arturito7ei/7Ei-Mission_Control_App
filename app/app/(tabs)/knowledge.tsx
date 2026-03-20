import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, RefreshControl, Alert } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../../store'
import { api, KnowledgeItem } from '../../lib/api'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { ThemedText } from '../../components/ThemedText'

const MIME_ICONS: Record<string, string> = {
  'application/vnd.google-apps.document': '📄',
  'application/vnd.google-apps.spreadsheet': '📊',
  'application/vnd.google-apps.presentation': '📹',
  'application/vnd.google-apps.folder': '📁',
  'text/plain': '📝', 'text/markdown': '📝',
  'application/pdf': '📄', 'folder': '📂',
}

export default function KnowledgeScreen() {
  const { currentOrg } = useStore()
  const { theme } = useTheme()
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mode, setMode] = useState<'browse' | 'search'>('browse')

  const load = useCallback(async () => {
    if (!currentOrg) return
    try { const { items: list } = await api.knowledge.list(currentOrg.id); setItems(list) }
    catch (e) { console.error(e) }
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const handleSearch = async () => {
    if (!searchQuery.trim() || !currentOrg) return
    setSearching(true)
    try {
      const { results } = await api.knowledge.search(currentOrg.id, searchQuery.trim())
      setSearchResults(results)
      setMode('search')
    } catch (e: any) {
      Alert.alert('Search error', e.message)
    } finally { setSearching(false) }
  }

  const displayItems = mode === 'search' ? searchResults : items

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* Search bar */}
      <View style={[styles.searchRow, { borderBottomColor: theme.border }]}>
        <TextInput
          style={[styles.searchInput, { backgroundColor: theme.surface, borderColor: theme.borderLight, color: theme.text }]}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Semantic search knowledge base..."
          placeholderTextColor={theme.textMuted}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
        <TouchableOpacity
          style={[styles.searchBtn, { backgroundColor: theme.accent }]}
          onPress={handleSearch}
          disabled={searching}
        >
          <Text style={styles.searchBtnText}>{searching ? '...' : '⌕'}</Text>
        </TouchableOpacity>
        {mode === 'search' && (
          <TouchableOpacity
            style={[styles.clearBtn, { borderColor: theme.borderLight }]}
            onPress={() => { setMode('browse'); setSearchQuery(''); setSearchResults([]) }}
          >
            <Text style={[styles.clearBtnText, { color: theme.textSecondary }]}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Mode indicator */}
      {mode === 'search' && (
        <View style={[styles.modeBanner, { backgroundColor: theme.accentDim, borderBottomColor: theme.accentBorder }]}>
          <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>
            {searchResults.length} semantic matches for "{searchQuery}"
          </ThemedText>
        </View>
      )}

      <FlatList
        data={displayItems}
        keyExtractor={i => (i as any).id}
        contentContainerStyle={styles.list}
        refreshControl={mode === 'browse' ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} /> : undefined}
        ListHeaderComponent={
          mode === 'browse' ? (
            <Card variant="accent" style={styles.banner}>
              <ThemedText variant="title" style={{ marginBottom: 4 }}>📚 Knowledge Base</ThemedText>
              <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>
                Files synced from Google Drive. Use semantic search to find anything.
              </ThemedText>
            </Card>
          ) : null
        }
        ListEmptyComponent={
          mode === 'search'
            ? <EmptyState emoji="🔍" title="No matches" subtitle="Try different keywords" />
            : <EmptyState emoji="📚" title="Knowledge base empty" subtitle="Connect Google Drive to add files" />
        }
        renderItem={({ item }) => {
          const icon = MIME_ICONS[(item as any).mimeType ?? ''] ?? ((item as any).type === 'folder' ? '📂' : '📄')
          const score = (item as any).score
          return (
            <Card style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.icon}>{icon}</Text>
                <View style={styles.info}>
                  <ThemedText variant="body" style={{ fontWeight: FontWeight.medium }} numberOfLines={1}>
                    {(item as any).name}
                  </ThemedText>
                  <ThemedText variant="muted">
                    {(item as any).backend?.replace('_', ' ')}
                    {score != null ? ` · ${(score * 100).toFixed(0)}% match` : ''}
                  </ThemedText>
                </View>
                {(item as any).externalUrl && (
                  <Text style={{ fontSize: 18 }}>🔗</Text>
                )}
              </View>
            </Card>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchRow: { flexDirection: 'row', padding: Space.lg, gap: Space.sm, borderBottomWidth: 0.5 },
  searchInput: { flex: 1, borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base },
  searchBtn: { width: 40, height: 40, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  searchBtnText: { fontSize: FontSize.xl, color: '#fff' },
  clearBtn: { width: 40, height: 40, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5 },
  clearBtnText: { fontSize: FontSize.base },
  modeBanner: { padding: Space.md, paddingHorizontal: Space.lg, borderBottomWidth: 0.5 },
  list: { padding: Space.lg, gap: Space.sm },
  banner: { marginBottom: Space.sm },
  card: { padding: Space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  icon: { fontSize: 24 },
  info: { flex: 1 },
})
