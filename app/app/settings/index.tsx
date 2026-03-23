import {
  View, Text, ScrollView, StyleSheet,
  TouchableOpacity, Switch, Alert,
} from 'react-native'
import { useRouter, Stack } from 'expo-router'
import { useAuth } from '@clerk/clerk-expo'
import { useColorScheme } from 'react-native'
import { useStore } from '../../store'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { ThemedText } from '../../components/ThemedText'
import { Divider } from '../../components/Divider'

const APP_VERSION = '1.0.0'
const BUILD = '1'

export default function SettingsScreen() {
  const router = useRouter()
  const { signOut, user } = useAuth()
  const { theme, mode } = useTheme()
  const { currentOrg, setCurrentOrg, setOrgs, setAgents, setTasks } = useStore()
  const systemScheme = useColorScheme()

  const handleSignOut = () => {
    Alert.alert('Sign out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
        setCurrentOrg(null); setOrgs([]); setAgents([]); setTasks([])
        await signOut()
      }},
    ])
  }

  const sections = [
    {
      title: 'Account',
      items: [
        {
          label: 'Signed in as',
          value: user?.primaryEmailAddress?.emailAddress ?? '—',
          type: 'info',
        },
        {
          label: 'Switch Organisation',
          type: 'nav',
          onPress: () => router.push('/org/switch'),
        },
        {
          label: 'Organisation Settings',
          type: 'nav',
          onPress: () => router.push('/org/settings'),
        },
      ],
    },
    {
      title: 'Appearance',
      items: [
        {
          label: 'Theme',
          value: systemScheme === 'dark' ? '🌙 Dark (system)' : '☀️ Light (system)',
          type: 'info',
          hint: 'Follows your device setting',
        },
      ],
    },
    {
      title: 'Integrations',
      items: [
        { label: 'Jira', type: 'nav', onPress: () => router.push('/jira') },
        { label: 'Gmail', type: 'nav', onPress: () => router.push('/gmail') },
        { label: 'Scheduled Tasks', type: 'nav', onPress: () => router.push('/scheduled') },
        { label: 'Outbound Webhooks', type: 'nav', onPress: () => router.push('/webhooks') },
      ],
    },
    {
      title: 'Data',
      items: [
        { label: 'Usage & Limits', type: 'nav', onPress: () => router.push('/usage') },
        { label: 'Knowledge Base', type: 'nav', onPress: () => router.push('/(tabs)/knowledge') },
        { label: 'Skill Library', type: 'nav', onPress: () => router.push('/skills') },
      ],
    },
    {
      title: 'About',
      items: [
        { label: 'Version', value: `${APP_VERSION} (${BUILD})`, type: 'info' },
        {
          label: 'GitHub',
          value: 'Arturito7ei/7Ei-Mission_Control_App',
          type: 'info',
        },
        {
          label: 'Privacy Policy',
          type: 'nav',
          onPress: () => router.push('https://7ei.ai/privacy' as any),
        },
      ],
    },
  ]

  return (
    <ScrollView style={[styles.scroll, { backgroundColor: theme.bg }]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Settings' }} />

      {/* Profile header */}
      <View style={[styles.profileCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={[styles.avatar, { backgroundColor: theme.accentDim, borderColor: theme.accentBorder }]}>
          <Text style={[styles.avatarText, { color: theme.accent }]}>
            {(user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? '?')[0].toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <ThemedText variant="title">
            {user?.firstName ? `${user.firstName} ${user.lastName ?? ''}`.trim() : 'Welcome'}
          </ThemedText>
          <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>
            {user?.primaryEmailAddress?.emailAddress ?? ''}
          </ThemedText>
        </View>
      </View>

      {sections.map(section => (
        <View key={section.title} style={styles.section}>
          <ThemedText variant="label" style={{ marginBottom: Space.sm }}>{section.title}</ThemedText>
          <Card style={styles.sectionCard}>
            {section.items.map((item: any, idx) => (
              <View key={item.label}>
                {idx > 0 && <Divider spacing={0} />}
                {item.type === 'nav' ? (
                  <TouchableOpacity style={styles.row} onPress={item.onPress}>
                    <ThemedText variant="body">{item.label}</ThemedText>
                    <ThemedText variant="muted">›</ThemedText>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <ThemedText variant="body">{item.label}</ThemedText>
                      {item.hint && <ThemedText variant="muted" style={{ fontSize: FontSize.xs }}>{item.hint}</ThemedText>}
                    </View>
                    {item.value && (
                      <ThemedText variant="muted" style={{ fontSize: FontSize.sm }} numberOfLines={1}>
                        {item.value}
                      </ThemedText>
                    )}
                  </View>
                )}
              </View>
            ))}
          </Card>
        </View>
      ))}

      {/* Sign out */}
      <TouchableOpacity
        style={[styles.signOutBtn, { backgroundColor: theme.statusErrorBg, borderColor: theme.borderError }]}
        onPress={handleSignOut}
      >
        <Text style={[styles.signOutText, { color: theme.statusError }]}>Sign out</Text>
      </TouchableOpacity>

      <ThemedText variant="muted" style={styles.footer}>
        7Ei Mission Control · v{APP_VERSION} · Made in Zürich
      </ThemedText>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Space.lg, gap: Space.xl, paddingBottom: 48 },
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.lg, borderRadius: Radius.lg, borderWidth: 0.5 },
  avatar: { width: 52, height: 52, borderRadius: 26, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold },
  section: {},
  sectionCard: { padding: 0, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg, gap: Space.md },
  signOutBtn: { padding: Space.lg, borderRadius: Radius.md, borderWidth: 0.5, alignItems: 'center' },
  signOutText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  footer: { textAlign: 'center', fontSize: FontSize.xs },
})
