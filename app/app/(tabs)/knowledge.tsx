import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, RefreshControl, Alert, Modal, ScrollView, KeyboardAvoidingView, Platform } from 'react-native'
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
  const [showUpload, setShowUpload] = useState(false)
  const [uploadName, setUploadName] = useState('')
  const [uploadContent, setUploadContent] = useState('')
  const [uploading, setUploading] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try { const { items: list } = await api.knowledge.list(currentOrg.id); setItems(list) }
    catch (e) { console.error(e) }
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const handleUpload = async () => {
    if (!uploadName.trim() || !uploadContent.trim() || !currentOrg) return
    setUploading(true)
    try {
      await api.knowledge.upload(currentOrg.id, { name: uploadName.trim(), content: uploadContent.trim() })
      setShowUpload(false)
      setUploadName('')
      setUploadContent('')
      await load()
    } catch (e: any) {
      Alert.alert('Upload failed', e.message)
    } finally {
      setUploading(false)
    }
  }

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
      {/* Upload modal */}
      <Modal visible={showUpload} animationType="slide" transparent onRequestClose={() => setShowUpload(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Upload .md File</Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: theme.bg, borderColor: theme.borderLight, color: theme.text }]}
              value={uploadName}
              onChangeText={setUploadName}
              placeholder="File name (e.g. strategy.md)"
              placeholderTextColor={theme.textMuted}
            />
            <TextInput
              style={[styles.modalContent, { backgroundColor: theme.bg, borderColor: theme.borderLight, color: theme.text }]}
              value={uploadContent}
              onChangeText={setUploadContent}
              placeholder="Paste markdown content here..."
              placeholderTextColor={theme.textMuted}
              multiline
              textAlignVertical="top"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, { borderColor: theme.borderLight }]}
                onPress={() => { setShowUpload(false); setUploadName(''); setUploadContent('') }}
              >
                <Text style={{ color: theme.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary, { backgroundColor: theme.accent }]}
                onPress={handleUpload}
                disabled={uploading}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>{uploading ? 'Uploading...' : 'Upload'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
              <TouchableOpacity
                style={[styles.uploadBtn, { backgroundColor: theme.accent }]}
                onPress={() => setShowUpload(true)}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>+ Upload .md</Text>
              </TouchableOpacity>
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
  uploadBtn: { marginTop: Space.md, padding: Space.md, borderRadius: Radius.md, alignItems: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalCard: { borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, padding: Space.xl, gap: Space.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Space.sm },
  modalInput: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base },
  modalContent: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base, height: 160 },
  modalActions: { flexDirection: 'row', gap: Space.md, justifyContent: 'flex-end', marginTop: Space.sm },
  modalBtn: { paddingVertical: Space.md, paddingHorizontal: Space.lg, borderRadius: Radius.md, borderWidth: 0.5 },
  modalBtnPrimary: { borderWidth: 0 },
})
