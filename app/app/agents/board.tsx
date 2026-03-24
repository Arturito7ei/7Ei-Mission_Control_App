import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api, Agent } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { AgentAvatar } from '../../components/AgentAvatar'
import { EmptyState } from '../../components/EmptyState'

export default function SilverBoardScreen() {
  const router = useRouter()
  const { currentOrg } = useStore()
  const [advisors, setAdvisors] = useState<Agent[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!currentOrg) return
    try {
      const { agents } = await api.agents.list(currentOrg.id)
      setAdvisors(agents.filter(a => a.agentType === 'advisor'))
    } catch {}
  }, [currentOrg])

  useEffect(() => { load() }, [load])

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <View style={styles.container}>
      <FlatList
        data={advisors}
        keyExtractor={a => a.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={
          <EmptyState
            emoji="🎖️"
            title="No advisors yet"
            subtitle="Add your first advisor from the Create Agent screen"
            actionLabel="Add Advisor"
            onAction={() => router.push('/agents/create')}
          />
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.cardWrap} onPress={() => router.push(`/agents/${item.id}`)}>
            <Card style={styles.card}>
              <AgentAvatar emoji={item.avatarEmoji} size={48} />
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.role} numberOfLines={1}>{item.role}</Text>
              {item.advisorPersona && (
                <Text style={styles.persona} numberOfLines={2}>{item.advisorPersona}</Text>
              )}
            </Card>
          </TouchableOpacity>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  list: { padding: Space.lg, gap: Space.sm },
  row: { gap: Space.sm },
  cardWrap: { flex: 1 },
  card: { padding: Space.lg, alignItems: 'center', gap: Space.xs },
  name: { fontSize: 16, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  role: { fontSize: 12, color: Colors.textSecondary, textAlign: 'center' },
  persona: { fontSize: 11, color: Colors.textMuted, textAlign: 'center', marginTop: Space.xs, fontStyle: 'italic' },
})
