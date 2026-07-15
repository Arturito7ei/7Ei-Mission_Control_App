// Sign-in / connect screen (phase-1 token-paste auth).
//
// The operator pastes a bearer token (a Clerk session JWT from the web dashboard)
// and, optionally, an API URL (defaults to the hosted backend). We validate it by
// resolving orgs; if there is more than one, they pick. Clerk-Expo (MOB-2) will
// replace this with a real sign-in form — screens downstream won't change.

import React, { useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useAuth } from '../auth'
import { DEFAULT_API_URL } from '../config'
import type { Org } from '../api'
import { font, radius, space, theme } from '../theme'
import { Banner, Button, Card } from '../ui'

export default function ConnectScreen() {
  const { connect, chooseOrg } = useAuth()
  const [token, setToken] = useState('')
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [orgs, setOrgs] = useState<Org[] | null>(null)

  async function onConnect() {
    setError(null)
    setBusy(true)
    try {
      const found = await connect(token.trim(), apiUrl.trim())
      if (found.length === 0) {
        setError('Token valid, but no organisations found for this user.')
      } else if (found.length > 1) {
        setOrgs(found) // let the operator pick
      }
      // length === 1 → connect() already selected it; the app switches to tabs.
    } catch (e: any) {
      setError(e?.message ?? 'Could not connect.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <Text style={s.brand}>7Ei Mission Control</Text>
        <Text style={s.tag}>iPhone remote — thin client to the hosted backend</Text>

        {orgs ? (
          <Card style={{ marginTop: space.xl }}>
            <Text style={s.label}>Choose an organisation</Text>
            {orgs.map((o) => (
              <View key={o.id} style={{ marginTop: space.md }}>
                <Button title={o.name || o.id} onPress={() => chooseOrg(o)} tone="primary" />
              </View>
            ))}
          </Card>
        ) : (
          <Card style={{ marginTop: space.xl }}>
            <Text style={s.label}>Bearer token</Text>
            <Text style={s.help}>
              Paste a Clerk session token from the web dashboard. (Phase 1 — Clerk-Expo sign-in
              lands in MOB-2.)
            </Text>
            <TextInput
              style={s.input}
              value={token}
              onChangeText={setToken}
              placeholder="eyJhbGciOi…"
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />

            <Text style={[s.label, { marginTop: space.lg }]}>API URL</Text>
            <TextInput
              style={s.input}
              value={apiUrl}
              onChangeText={setApiUrl}
              placeholder={DEFAULT_API_URL}
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />

            {error ? (
              <View style={{ marginTop: space.lg }}>
                <Banner kind="error">{error}</Banner>
              </View>
            ) : null}

            <View style={{ marginTop: space.lg }}>
              <Button
                title="Connect"
                onPress={onConnect}
                busy={busy}
                disabled={!token.trim()}
              />
            </View>
            <Text style={[s.help, { marginTop: space.md }]}>
              Note: a raw Clerk session token is short-lived — fine for a smoke test; MOB-2
              (Clerk-Expo) auto-refreshes.
            </Text>
          </Card>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, paddingTop: space.xxl },
  brand: { color: theme.text, fontSize: font.xxl, fontWeight: '800' },
  tag: { color: theme.textDim, fontSize: font.base, marginTop: space.xs },
  label: { color: theme.text, fontSize: font.base, fontWeight: '700' },
  help: { color: theme.textDim, fontSize: font.sm, marginTop: space.xs, lineHeight: 18 },
  input: {
    marginTop: space.sm,
    backgroundColor: theme.s2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.s3,
    color: theme.text,
    padding: space.md,
    fontSize: font.base,
    minHeight: 46,
  },
})
