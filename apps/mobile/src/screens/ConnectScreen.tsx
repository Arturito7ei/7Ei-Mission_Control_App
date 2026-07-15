// Sign-in / connect screen.
//
// Two paths share this screen (MOB-2):
//   • CLERK (primary) — a real Clerk sign-in against the SAME Clerk instance the
//     web app uses (email + password, or an emailed sign-in code). Shown when
//     EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is configured. After sign-in we resolve the
//     backend orgs the Clerk user can see and (if >1) let them pick.
//   • PASTE (escape hatch / MOB-1 fallback) — paste a bearer token + API URL. Always
//     available: it's the ONLY path when no Clerk key is set, and a toggle behind
//     the Clerk form when one is. This guarantees the app always boots.
//
// Downstream screens never see which path was used — they depend only on
// getToken() + orgId. See docs/DESIGN-mobile-expo.md §2.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSignIn } from '@clerk/clerk-expo'
import { useAuth } from '../auth'
import { DEFAULT_API_URL } from '../config'
import type { Org } from '../api'
import { font, radius, space, theme } from '../theme'
import { Banner, Button, Card, Loading } from '../ui'

// ─── Public screen — routes to the right path ───────────────────────────────────

export default function ConnectScreen() {
  const { clerkEnabled } = useAuth()
  return clerkEnabled ? <ClerkConnect /> : <PasteConnect />
}

// ─── Shared building blocks ─────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <Text style={s.brand}>7Ei Mission Control</Text>
        <Text style={s.tag}>iPhone remote — thin client to the hosted backend</Text>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function OrgPicker({ orgs, onPick }: { orgs: Org[]; onPick: (o: Org) => void }) {
  return (
    <Card style={{ marginTop: space.xl }}>
      <Text style={s.label}>Choose an organisation</Text>
      {orgs.map((o) => (
        <View key={o.id} style={{ marginTop: space.md }}>
          <Button title={o.name || o.id} onPress={() => onPick(o)} tone="primary" />
        </View>
      ))}
    </Card>
  )
}

function LabeledInput(props: {
  label: string
  value: string
  onChangeText: (t: string) => void
  placeholder?: string
  secureTextEntry?: boolean
  keyboardType?: 'default' | 'email-address' | 'url' | 'number-pad'
  multiline?: boolean
  style?: object
}) {
  return (
    <>
      <Text style={[s.label, props.style]}>{props.label}</Text>
      <TextInput
        style={s.input}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={theme.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={props.secureTextEntry}
        keyboardType={props.keyboardType}
        multiline={props.multiline}
      />
    </>
  )
}

function apiErr(e: any): string {
  // Clerk errors carry .errors[].longMessage/message; fall back to .message.
  const c = e?.errors?.[0]
  return c?.longMessage || c?.message || e?.message || 'Something went wrong.'
}

// ─── Paste path (MOB-1 fallback; the whole screen when no Clerk key) ─────────────

function PasteForm({
  onDone,
  compact,
}: {
  onDone: (orgs: Org[]) => void
  compact?: boolean
}) {
  const { connect } = useAuth()
  const [token, setToken] = useState('')
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConnect() {
    setError(null)
    setBusy(true)
    try {
      const found = await connect(token.trim(), apiUrl.trim())
      if (found.length === 0) setError('Token valid, but no organisations found for this user.')
      else onDone(found) // length 1 → auth already selected it; >1 → caller shows picker
    } catch (e: any) {
      setError(apiErr(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <LabeledInput
        label="Bearer token"
        value={token}
        onChangeText={setToken}
        placeholder="eyJhbGciOi…"
        multiline
      />
      <Text style={s.help}>
        {compact
          ? 'Escape hatch: paste a Clerk session token from the web dashboard (short-lived).'
          : 'Paste a Clerk session token from the web dashboard.'}
      </Text>

      <LabeledInput
        label="API URL"
        value={apiUrl}
        onChangeText={setApiUrl}
        placeholder={DEFAULT_API_URL}
        keyboardType="url"
        style={{ marginTop: space.lg }}
      />

      {error ? (
        <View style={{ marginTop: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      <View style={{ marginTop: space.lg }}>
        <Button title="Connect" onPress={onConnect} busy={busy} disabled={!token.trim()} />
      </View>
    </>
  )
}

// Self-contained paste flow: the form, plus a local org picker for the >1-org case.
// Keeping the picker state HERE (not via a re-render round-trip through the provider)
// means a multi-org paste still shows the picker in either mode.
function PasteFlow({ compact }: { compact?: boolean }) {
  const { chooseOrg } = useAuth()
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  if (orgs) return <OrgPicker orgs={orgs} onPick={chooseOrg} />
  return (
    <PasteForm
      compact={compact}
      onDone={(found) => {
        if (found.length > 1) setOrgs(found)
      }}
    />
  )
}

function PasteConnect() {
  return (
    <Shell>
      <Card style={{ marginTop: space.xl }}>
        <PasteFlow />
        <Text style={[s.help, { marginTop: space.md }]}>
          Note: a raw Clerk session token is short-lived — fine for a smoke test. Configure
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY for real, auto-refreshing Clerk sign-in.
        </Text>
      </Card>
    </Shell>
  )
}

// ─── Clerk path (primary; only mounted when a Clerk key is configured) ───────────

function ClerkConnect() {
  const { clerkSignedIn, orgId, resolveClerkOrgs, chooseOrg } = useAuth()

  // Once signed in via Clerk but no org chosen yet, resolve + (maybe) pick.
  if (clerkSignedIn && !orgId) return <ClerkOrgResolve resolve={resolveClerkOrgs} onPick={chooseOrg} />

  // Signed in AND org chosen → the App shell takes over (this screen won't render).
  // Not signed in → the sign-in form.
  return <ClerkSignIn />
}

function ClerkOrgResolve({
  resolve,
  onPick,
}: {
  resolve: (apiUrl?: string) => Promise<Org[]>
  onPick: (o: Org) => Promise<void> | void
}) {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Resolve EXACTLY once on mount. `resolve` closes over Clerk's hook object, whose
  // identity can change every render — depending on it would re-fire the network
  // call (and re-persist) in a loop for the >1-org case. A ref guard is the fix.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    let alive = true
    resolve()
      .then((found) => {
        if (!alive) return
        // length 1 → resolve() already selected it (orgId set) → App leaves this screen.
        if (found.length === 0) setError('Signed in, but no organisations found for this user.')
        else if (found.length > 1) setOrgs(found)
      })
      .catch((e) => alive && setError(apiErr(e)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) {
    return (
      <Shell>
        <View style={{ marginTop: space.xl }}>
          <Banner kind="error">{error}</Banner>
        </View>
        <Text style={[s.help, { marginTop: space.md }]}>
          Pull the app closed and retry, or Disconnect from the Status tab.
        </Text>
      </Shell>
    )
  }
  if (orgs) {
    return (
      <Shell>
        <OrgPicker orgs={orgs} onPick={onPick} />
      </Shell>
    )
  }
  return <Loading text="Signed in — finding your organisations…" />
}

function ClerkSignIn() {
  const { signIn, setActive, isLoaded } = useSignIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usePaste, setUsePaste] = useState(false)
  // Email-code sub-flow state.
  const [codeMode, setCodeMode] = useState(false)
  const [code, setCode] = useState('')

  const finish = useCallback(
    async (createdSessionId: string | null | undefined) => {
      if (createdSessionId && setActive) await setActive({ session: createdSessionId })
      // setActive flips Clerk's isSignedIn → ClerkConnect re-renders into org resolve.
    },
    [setActive],
  )

  const onPassword = useCallback(async () => {
    if (!isLoaded || !signIn) return
    setError(null)
    setBusy(true)
    try {
      const res = await signIn.create({ identifier: email.trim(), password })
      if (res.status === 'complete') await finish(res.createdSessionId)
      else setError(`Additional verification required (status: ${res.status}). Try the email code.`)
    } catch (e: any) {
      setError(apiErr(e))
    } finally {
      setBusy(false)
    }
  }, [isLoaded, signIn, email, password, finish])

  const onSendCode = useCallback(async () => {
    if (!isLoaded || !signIn) return
    setError(null)
    setBusy(true)
    try {
      const res = await signIn.create({ identifier: email.trim() })
      const factor: any = (res.supportedFirstFactors ?? []).find(
        (f: any) => f.strategy === 'email_code',
      )
      if (!factor) {
        setError('This account has no email-code sign-in. Use your password, or the web dashboard.')
        return
      }
      await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId })
      setCodeMode(true)
    } catch (e: any) {
      setError(apiErr(e))
    } finally {
      setBusy(false)
    }
  }, [isLoaded, signIn, email])

  const onVerifyCode = useCallback(async () => {
    if (!isLoaded || !signIn) return
    setError(null)
    setBusy(true)
    try {
      const res = await signIn.attemptFirstFactor({ strategy: 'email_code', code: code.trim() })
      if (res.status === 'complete') await finish(res.createdSessionId)
      else setError(`Could not complete sign-in (status: ${res.status}).`)
    } catch (e: any) {
      setError(apiErr(e))
    } finally {
      setBusy(false)
    }
  }, [isLoaded, signIn, code, finish])

  if (usePaste) {
    return (
      <Shell>
        <Card style={{ marginTop: space.xl }}>
          <Text style={s.label}>Sign in with a token</Text>
          <PasteFlow compact />
          <View style={{ marginTop: space.lg }}>
            <Button title="← Back to Clerk sign-in" onPress={() => setUsePaste(false)} tone="ghost" />
          </View>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <Card style={{ marginTop: space.xl }}>
        <Text style={s.label}>Sign in</Text>
        <Text style={s.help}>Use your 7Ei Clerk account — the same login as the web dashboard.</Text>

        <LabeledInput
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@7ei.ai"
          keyboardType="email-address"
          style={{ marginTop: space.lg }}
        />

        {codeMode ? (
          <>
            <LabeledInput
              label="Email code"
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              style={{ marginTop: space.lg }}
            />
            {error ? (
              <View style={{ marginTop: space.lg }}>
                <Banner kind="error">{error}</Banner>
              </View>
            ) : null}
            <View style={{ marginTop: space.lg }}>
              <Button title="Verify code" onPress={onVerifyCode} busy={busy} disabled={!code.trim()} />
            </View>
            <View style={{ marginTop: space.sm }}>
              <Button title="Use password instead" onPress={() => setCodeMode(false)} tone="ghost" />
            </View>
          </>
        ) : (
          <>
            <LabeledInput
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
              style={{ marginTop: space.lg }}
            />
            {error ? (
              <View style={{ marginTop: space.lg }}>
                <Banner kind="error">{error}</Banner>
              </View>
            ) : null}
            <View style={{ marginTop: space.lg }}>
              <Button
                title="Sign in"
                onPress={onPassword}
                busy={busy}
                disabled={!email.trim() || !password}
              />
            </View>
            <View style={{ marginTop: space.sm }}>
              <Button
                title="Email me a sign-in code"
                onPress={onSendCode}
                tone="ghost"
                busy={busy}
                disabled={!email.trim()}
              />
            </View>
          </>
        )}

        {!isLoaded ? (
          <View style={{ marginTop: space.md, flexDirection: 'row', alignItems: 'center' }}>
            <ActivityIndicator color={theme.blue} />
            <Text style={[s.help, { marginLeft: space.sm, marginTop: 0 }]}>Loading Clerk…</Text>
          </View>
        ) : null}
      </Card>

      <Card style={{ marginTop: space.lg }}>
        <Text style={s.help}>
          Can't sign in? Use a pasted session token instead (short-lived; for a smoke test).
        </Text>
        <View style={{ marginTop: space.md }}>
          <Button title="Use a token instead" onPress={() => setUsePaste(true)} tone="ghost" />
        </View>
      </Card>
    </Shell>
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
