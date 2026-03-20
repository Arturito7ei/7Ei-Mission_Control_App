import { View, Text, FlatList, StyleSheet, TouchableOpacity, Alert, RefreshControl } from 'react-native'
import { useEffect, useState, useCallback } from 'react'
import { useRouter, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api, Org } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'

export default function OrgSwitcherScreen() {
  const router = useRouter()
  const { currentOrg, setCurrentOrg, setOrgs, setAgents, setTasks, setDepartments, setProjects } = useStore()
  const [orgs, setLocalOrgs] = useState<Org[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { orgs: list } = await api.orgs.listForSwitch()
      setLocalOrgs(list)
    } catch {
      const { orgs: list } = await api.orgs.list()
      setLocalOrgs(list)
    }
  }, [])

  useEffect(() => { load() }, [load])
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }

  const switchOrg = async (org: Org) => {
    if (org.id === currentOrg?.id) { router.back(); return }
    setSwitching(org.id)
    try {
      const [{ agents }, { tasks }, { departments }, { projects }] = await Promise.all([
        api.agents.list(org.id), api.tasks.list(org.id),
        api.orgs.departments.list(org.id), api.projects.list(org.id),
      ])
      setCurrentOrg(org); setOrgs(orgs)
      setAgents(agents); setTasks(tasks); setDepartments(departments); setProjects(projects)
      router.replace('/(tabs)')
    } catch (e: any) { Alert.alert('Switch failed', e.message) }
    finally { setSwitching(null) }
  }

  const handleDuplicate = (org: Org) => {
    Alert.alert('Duplicate Org', `Create a copy of "${org.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Duplicate', onPress: async () => {
        try {
          const result = await api.orgs.duplicate(org.id)
          Alert.alert('Duplicated', `"${result.name}" created with ${result.agentsCopied} agents`)
          await load()
        } catch (e: any) { Alert.alert('Error', e.message) }
      }},
    ])
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Switch Organisation' }} />
      <FlatList
        data={orgs}
        keyExtractor={o => o.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.listHeaderText}>{orgs.length} organisation{orgs.length !== 1 ? 's' : ''}</Text>
            <TouchableOpacity style={styles.newOrgBtn} onPress={() => router.push('/org/create')}>
              <Text style={styles.newOrgBtnText}>+ New Org</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item: org }) => {
          const isCurrent = org.id === currentOrg?.id
          const isLoading = switching === org.id
          return (
            <Card style={[styles.orgCard, isCurrent && styles.orgCardActive]}>
              <TouchableOpacity onPress={() => switchOrg(org)} disabled={isLoading}>
                <View style={styles.orgHeader}>
                  <View style={styles.orgIcon}><Text style={styles.orgIconText}>{org.name.charAt(0).toUpperCase()}</Text></View>
                  <View style={styles.orgInfo}>
                    <View style={styles.orgTitleRow}>
                      <Text style={styles.orgName}>{org.name}</Text>
                      {isCurrent && <Text style={styles.currentTag}>Active</Text>}
                    </View>
                    {org.description && <Text style={styles.orgDesc} numberOfLines={1}>{org.description}</Text>}
                    <View style={styles.orgStats}>
                      {org.agentCount != null && <Text style={styles.orgStat}>{org.agentCount} agents</Text>}
                      {org.activeAgents != null && org.activeAgents > 0 && <Text style={[styles.orgStat, { color: Colors.active }]}>{org.activeAgents} active</Text>}
                      {org.pendingTasks != null && org.pendingTasks > 0 && <Text style={[styles.orgStat, { color: Colors.warning }]}>{org.pendingTasks} pending</Text>}
                    </View>
                  </View>
                  <Text style={[styles.switchArrow, isCurrent && { color: Colors.accent }]}>{isLoading ? '...' : isCurrent ? '✓' : '→'}</Text>
                </View>
              </TouchableOpacity>
              <View style={styles.orgActionRow}>
                <TouchableOpacity style={styles.actionBtn} onPress={() => handleDuplicate(org)}>
                  <Text style={styles.actionBtnText}>⻧ Duplicate</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => router.push('/org/settings')}>
                  <Text style={styles.actionBtnText}>⚙️ Settings</Text>
                </TouchableOpacity>
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
  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Space.sm },
  listHeaderText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  newOrgBtn: { backgroundColor: Colors.accent, paddingHorizontal: Space.md, paddingVertical: Space.xs + 2, borderRadius: Radius.md },
  newOrgBtnText: { fontSize: 13, fontWeight: '700', color: '#000' },
  orgCard: { padding: Space.md, gap: Space.sm },
  orgCardActive: { borderColor: Colors.accent },
  orgHeader: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  orgIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: Colors.accentDim, borderWidth: 1, borderColor: Colors.accent + '44', alignItems: 'center', justifyContent: 'center' },
  orgIconText: { fontSize: 20, fontWeight: '800', color: Colors.accent },
  orgInfo: { flex: 1, gap: 3 },
  orgTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  orgName: { fontSize: 16, fontWeight: '700', color: Colors.text },
  currentTag: { fontSize: 11, color: Colors.accent, backgroundColor: Colors.accentDim, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, fontWeight: '700' },
  orgDesc: { fontSize: 13, color: Colors.textSecondary },
  orgStats: { flexDirection: 'row', gap: Space.sm, marginTop: 2 },
  orgStat: { fontSize: 12, color: Colors.textMuted },
  switchArrow: { fontSize: 18, color: Colors.textMuted },
  orgActionRow: { flexDirection: 'row', gap: Space.sm, paddingTop: Space.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  actionBtn: { flex: 1, paddingVertical: Space.xs + 2, alignItems: 'center', backgroundColor: Colors.surfaceHigh, borderRadius: Radius.sm, borderWidth: 1, borderColor: Colors.border },
  actionBtnText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
})
