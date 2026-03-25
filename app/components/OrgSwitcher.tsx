import { View, Text, TouchableOpacity, StyleSheet, Modal, FlatList } from 'react-native'
import { useState } from 'react'
import { useStore } from '../store'
import { Colors, Space, Radius } from '../constants/colors'

export function OrgSwitcher() {
  const { currentOrg, orgs, setCurrentOrg } = useStore()
  const [open, setOpen] = useState(false)

  if (!currentOrg || orgs.length <= 1) return null

  return (
    <>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Text style={styles.orgName} numberOfLines={1}>{currentOrg.name}</Text>
        <Text style={styles.caret}>▾</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.dropdown}>
            <Text style={styles.dropdownTitle}>Switch Organisation</Text>
            <FlatList
              data={orgs}
              keyExtractor={o => o.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.orgRow, item.id === currentOrg.id && styles.orgRowActive]}
                  onPress={() => { setCurrentOrg(item); setOpen(false) }}
                >
                  <Text style={[styles.orgRowText, item.id === currentOrg.id && styles.orgRowTextActive]}>
                    {item.name}
                  </Text>
                  {item.id === currentOrg.id && <Text style={styles.check}>✓</Text>}
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: Space.md },
  orgName: { fontSize: 14, fontWeight: '600', color: Colors.accent, maxWidth: 150 },
  caret: { fontSize: 12, color: Colors.accent },
  overlay: { flex: 1, justifyContent: 'flex-start', paddingTop: 100, backgroundColor: 'rgba(0,0,0,0.4)' },
  dropdown: { marginHorizontal: Space.lg, backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Space.md, maxHeight: 300, borderWidth: 1, borderColor: Colors.border },
  dropdownTitle: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: Space.sm, paddingHorizontal: Space.sm },
  orgRow: { paddingVertical: Space.md, paddingHorizontal: Space.md, borderRadius: Radius.sm, flexDirection: 'row', alignItems: 'center' },
  orgRowActive: { backgroundColor: Colors.accentDim },
  orgRowText: { fontSize: 15, color: Colors.text, flex: 1 },
  orgRowTextActive: { fontWeight: '700', color: Colors.accent },
  check: { fontSize: 14, color: Colors.accent },
})
