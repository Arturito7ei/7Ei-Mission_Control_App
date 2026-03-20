import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { Colors, Space, Radius } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'

export default function SkillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { skills, agents } = useStore()
  const skill = skills.find(s => s.id === id)

  if (!skill) return null

  const handleAssign = async (agentId: string) => {
    try {
      await api.agents.assignSkill(agentId, skill.id)
      Alert.alert('Assigned', `${skill.name} assigned to agent`)
    } catch (e: any) {
      Alert.alert('Error', e.message)
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: skill.name }} />
      <Card style={styles.header}>
        <Text style={styles.skillName}>{skill.name}</Text>
        <Text style={styles.domain}>{skill.domain}</Text>
        {skill.description && <Text style={styles.desc}>{skill.description}</Text>}
        <View style={styles.metaRow}>
          <Text style={styles.sourceTag}>{skill.source}</Text>
        </View>
      </Card>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Skill Instructions</Text>
        <View style={styles.codeBlock}>
          <Text style={styles.code}>{skill.content.slice(0, 800)}{skill.content.length > 800 ? '...' : ''}</Text>
        </View>
      </View>

      {agents.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Assign to Agent</Text>
          {agents.map(agent => (
            <Card key={agent.id} style={styles.agentRow}>
              <Text style={styles.agentName}>{agent.avatarEmoji} {agent.name}</Text>
              <Text style={styles.agentRole}>{agent.role}</Text>
              <Button
                label={agent.skills.includes(skill.name) ? '✓ Assigned' : 'Assign'}
                onPress={() => handleAssign(agent.id)}
                variant={agent.skills.includes(skill.name) ? 'secondary' : 'primary'}
                disabled={agent.skills.includes(skill.name)}
              />
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Space.lg, gap: Space.lg, paddingBottom: 48 },
  header: { gap: Space.sm },
  skillName: { fontSize: 20, fontWeight: '800', color: Colors.text },
  domain: { fontSize: 13, color: Colors.textSecondary, textTransform: 'capitalize' },
  desc: { fontSize: 14, color: Colors.textSecondary, lineHeight: 20 },
  metaRow: { flexDirection: 'row', gap: Space.sm },
  sourceTag: { fontSize: 12, color: Colors.textMuted, backgroundColor: Colors.surfaceHigh, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  section: { gap: Space.sm },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  codeBlock: { backgroundColor: Colors.surfaceHigh, borderRadius: Radius.md, padding: Space.md, borderWidth: 1, borderColor: Colors.border },
  code: { fontSize: 12, color: Colors.textSecondary, fontFamily: 'monospace', lineHeight: 18 },
  agentRow: { gap: Space.xs },
  agentName: { fontSize: 15, fontWeight: '600', color: Colors.text },
  agentRole: { fontSize: 12, color: Colors.textSecondary },
})
