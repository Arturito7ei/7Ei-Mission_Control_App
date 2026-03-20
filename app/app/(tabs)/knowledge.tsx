import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../../store'
import { api, KnowledgeItem } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'

const MIME_ICONS: Record<string, string> = {
  'application/vnd.google-apps.document': '📄',
  'application/vnd.google-apps.spreadsheet': '📊',
  'application/vnd.google-apps.presentation': '📹',
  'application/vnd.google-apps.folder': '📁',
  'text/plain': '📝',
  'text/markdown': '📝',
  'application/pdf': '📄',
  folder: '📂',
}

export default function KnowledgeScreen() {
  const { currentOrg } = useStore()
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const { items: list } = await api.knowledge.list(currentOrg.id)
      setItems(list)
    } catch (e) { console.error(e) }
  }, [currentOrg])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={i => i.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListHeaderComponent={
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>📚 Knowledge Base</Text>
            <Text style={styles.bannerSub}>Files and docs synced from Google Drive</Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState emoji="📚" title="Knowledge base empty" subtitle="Connect Google Drive to start adding files" />
        }
        renderItem={({ item }) => {
          const icon = MIME_ICONS[item.mimeType ?? ''] ?? (item.type === 'folder' ? '📂' : '📄')
          return (
            <Card style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.icon}>{icon}</Text>
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.backend}>{item.backend.replace('_', ' ')}</Text>
                </View>
                {item.externalUrl && (
                  <Text style={styles.link}>🔗</Text>
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
  container: { flex: 1, backgroundColor: Colors.bg },
  list: { padding: Space.lg, gap: Space.sm },
  banner: { backgroundColor: Colors.surfaceHigh, borderRadius: Radius.md, padding: Space.lg, marginBottom: Space.sm, borderWidth: 1, borderColor: Colors.border, gap: 4 },
  bannerTitle: { fontSize: 18, fontWeight: '700', color: Colors.text },
  bannerSub: { fontSize: 13, color: Colors.textSecondary },
  card: { padding: Space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  icon: { fontSize: 24 },
  info: { flex: 1 },
  name: { fontSize: 14, fontWeight: '600', color: Colors.text },
  backend: { fontSize: 12, color: Colors.textMuted, marginTop: 2, textTransform: 'capitalize' },
  link: { fontSize: 18 },
})
