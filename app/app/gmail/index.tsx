import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Alert, FlatList } from 'react-native'
import { useState, useCallback, useEffect } from 'react'
import { Stack } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import * as AuthSession from 'expo-auth-session'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { useTheme } from '../../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../../constants/colors'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ThemedText } from '../../components/ThemedText'

WebBrowser.maybeCompleteAuthSession()

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? ''

discovery is the OpenID config endpoint
const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'openid', 'email', 'profile',
]

export default function GmailScreen() {
  const { currentOrg } = useStore()
  const { theme } = useTheme()
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [threads, setThreads] = useState<any[]>([])
  const [selectedThread, setSelectedThread] = useState<any | null>(null)
  const [composeTo, setComposeTo] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [sending, setSending] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [loading, setLoading] = useState(false)

  const redirectUri = AuthSession.makeRedirectUri({ scheme: '7ei', path: 'gmail/callback' })

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      redirectUri,
      scopes: SCOPES,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
    },
    discovery
  )

  useEffect(() => {
    if (response?.type !== 'success') return
    ;(async () => {
      const { code } = response.params
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: request?.codeVerifier ?? '',
          }).toString(),
        })
        const tokens = await tokenRes.json() as any
        if (tokens.access_token) {
          setAccessToken(tokens.access_token)
          loadThreads(tokens.access_token)
        } else {
          Alert.alert('Auth failed', tokens.error_description ?? 'Could not get access token')
        }
      } catch (e: any) { Alert.alert('Auth error', e.message) }
    })()
  }, [response])

  const loadThreads = useCallback(async (token?: string) => {
    if (!currentOrg) return
    const t = token ?? accessToken
    if (!t) return
    setLoading(true)
    try {
      const { threads: list } = await api.comms.gmail.threads(currentOrg.id, t)
      setThreads(list ?? [])
    } catch (e: any) { Alert.alert('Error', e.message) }
    finally { setLoading(false) }
  }, [currentOrg, accessToken])

  const handleSend = async () => {
    if (!composeTo || !composeSubject || !composeBody || !accessToken || !currentOrg) return
    setSending(true)
    try {
      await api.comms.gmail.send(currentOrg.id, {
        accessToken, to: composeTo, subject: composeSubject, body: composeBody,
      })
      Alert.alert('Sent', 'Email sent successfully')
      setShowCompose(false); setComposeTo(''); setComposeSubject(''); setComposeBody('')
    } catch (e: any) { Alert.alert('Send failed', e.message) }
    finally { setSending(false) }
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: 'Gmail' }} />

      {!accessToken ? (
        <View style={styles.connectBox}>
          <Text style={styles.mailEmoji}>📧</Text>
          <ThemedText variant="heading" style={{ textAlign: 'center', marginBottom: 8 }}>Connect Gmail</ThemedText>
          <ThemedText variant="secondary" style={{ textAlign: 'center', marginBottom: 24 }}>
            Sign in with Google to read and send emails directly from Mission Control.
            Agents can draft replies on your behalf.
          </ThemedText>
          <Button
            label="Connect with Google"
            onPress={() => promptAsync()}
            disabled={!request}
          />
        </View>
      ) : (
        <>
          {/* Toolbar */}
          <View style={[styles.toolbar, { borderBottomColor: theme.border }]}>
            <ThemedText variant="secondary" style={{ fontSize: FontSize.sm }}>
              {threads.length} threads
            </ThemedText>
            <View style={styles.toolbarActions}>
              <TouchableOpacity
                style={[styles.iconBtn, { backgroundColor: theme.surfaceHigh, borderColor: theme.borderLight }]}
                onPress={() => loadThreads()}
              >
                <Text style={styles.iconBtnText}>↻</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.composeBtn, { backgroundColor: theme.accent }]}
                onPress={() => setShowCompose(true)}
              >
                <Text style={[styles.composeBtnText, { color: '#fff' }]}>✏️ Compose</Text>
              </TouchableOpacity>
            </View>
          </View>

          {showCompose && (
            <Card variant="accent" style={styles.composeCard}>
              <ThemedText variant="title" style={{ marginBottom: 12 }}>New Message</ThemedText>
              {([{ key: 'to', label: 'To', val: composeTo, set: setComposeTo, placeholder: 'recipient@email.com' },
                { key: 'subject', label: 'Subject', val: composeSubject, set: setComposeSubject, placeholder: 'Subject line' },
                { key: 'body', label: 'Message', val: composeBody, set: setComposeBody, placeholder: 'Write your message...', multi: true }] as any[]).map(f => (
                <View key={f.key} style={{ marginBottom: 10 }}>
                  <ThemedText variant="label" style={{ marginBottom: 4 }}>{f.label}</ThemedText>
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.borderLight, color: theme.text }, f.multi && styles.inputMulti]}
                    value={f.val} onChangeText={f.set}
                    placeholder={f.placeholder} placeholderTextColor={theme.textMuted}
                    multiline={f.multi}
                  />
                </View>
              ))}
              <View style={styles.composeFooter}>
                <Button label="Cancel" onPress={() => setShowCompose(false)} variant="secondary" style={{ flex: 1 }} />
                <Button label="Send" onPress={handleSend} loading={sending} style={{ flex: 1 }} />
              </View>
            </Card>
          )}

          <FlatList
            data={threads}
            keyExtractor={t => t.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={<EmptyState emoji="📭" title="No threads" subtitle="Pull to refresh" />}
            renderItem={({ item: thread }) => (
              <TouchableOpacity onPress={() => setSelectedThread(thread === selectedThread ? null : thread)}>
                <Card style={styles.threadCard}>
                  <ThemedText variant="body" style={{ fontWeight: FontWeight.medium }}>
                    {thread.snippet ?? thread.id}
                  </ThemedText>
                  <ThemedText variant="muted" style={{ marginTop: 4 }}>
                    {thread.id}
                  </ThemedText>
                </Card>
              </TouchableOpacity>
            )}
          />
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  connectBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xxxl },
  mailEmoji: { fontSize: 56, marginBottom: Space.lg },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Space.lg, borderBottomWidth: 0.5 },
  toolbarActions: { flexDirection: 'row', gap: Space.sm },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5 },
  iconBtnText: { fontSize: FontSize.lg },
  composeBtn: { paddingHorizontal: Space.md, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  composeBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  composeCard: { margin: Space.lg },
  input: { borderWidth: 0.5, borderRadius: Radius.md, padding: Space.md, fontSize: FontSize.base },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  composeFooter: { flexDirection: 'row', gap: Space.sm, marginTop: Space.sm },
  list: { padding: Space.lg, gap: Space.sm },
  threadCard: { padding: Space.md },
})
