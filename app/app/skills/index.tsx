import { View, Text, FlatList, StyleSheet, TouchableOpacity, Alert, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../../store'
import { api, Skill } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'

const DOMAIN_ICONS: Record<string, string> = {
  engineering: '🛠️', operations: '⚙️', knowledge: '📚',
  communication: '💬', 'project management': '💼', integration: '🔗', custom: '✨',
}

export default function SkillsScreen() {
  const router = useRouter()
  const { skills, setSkills } = useStore()
  const [syncing, setSyncing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const { skills: list } = await api.skills.list()
    setSkills(list)
  }, [])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const { synced } = await api.skills.sync()
      await load()
      Alert.alert('Synced', `${synced} skills synced from GitHub`)
    } catch (e: any) {
      Alert.alert('Sync failed', e.message)
    } finally {
      setSyncing(false)
    }
  }

  const grouped = skills.reduce((acc, s) => {
    if (!acc[s.domain]) acc[s.domain] = []
    acc[s.domain].push(s)
    return acc
  }, {} as Record<string, Skill[]>)

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Skill Library</Text>
        <Button label={syncing ? 'Syncing...' : '↻ Sync GitHub'} onPress={handleSync} loading={syncing} variant="secondary" />
      </View>

      <FlatList
        data={Object.entries(grouped)}
        keyExtractor={([domain]) => domain}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={
          <EmptyState emoji="⚡" title="No skills yet" subtitle="Tap Sync GitHub to import skills from the shared library" />
        }
        renderItem={({ item: [domain, domainSkills] }) => (
          <View style={styles.section}>
            <Text style={styles.domainTitle}>{DOMAIN_ICONS[domain] ?? '⚡'} {domain.charAt(0).toUpperCase() + domain.slice(1)}</Text>
            {domainSkills.map(skill => (
              <TouchableOpacity key={skill.id} onPress={() => router.push(`/skills/${skill.id}`)}>
                <Card style={styles.skillCard}>
                  <View style={styles.skillRow}>
                    <View style={styles.skillInfo}>
                      <Text style={styles.skillName}>{skill.name}</Text>
                      {skill.description && <Text style={styles.skillDesc} numberOfLines={2}>{skill.description}</Text>}
                    </View>
                    <View style={styles.skillMeta}>
                      <Text style={styles.sourceTag}>{skill.source}</Text>
                    </View>
                  </View>
                </Card>
              </TouchableOpacity>
            ))}
          </View>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg },
  title: { fontSize: 22, fontWeight: '800', color: Colors.text },
  list: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.md },
  section: { gap: Space.sm },
  domainTitle: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  skillCard: { padding: Space.md },
  skillRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  skillInfo: { flex: 1 },
  skillName: { fontSize: 15, fontWeight: '600', color: Colors.text },
  skillDesc: { fontSize: 13, color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },
  skillMeta: { alignItems: 'flex-end', gap: 4 },
  sourceTag: { fontSize: 11, color: Colors.textMuted, backgroundColor: Colors.surfaceHigh, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, textTransform: 'capitalize' },
})
