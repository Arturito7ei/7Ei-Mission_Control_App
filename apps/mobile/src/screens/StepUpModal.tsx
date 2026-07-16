// MOB-4 — the on-device step-up modal for APPROVING a dangerous action.
//
// Opened only when the operator taps Approve on a dangerous approval
// (file_destructive | wallet_tx | email_send | machine_exec). It:
//   1. Shows the danger CLEARLY — type + the backend's machine-rendered summary
//      + every danger warning (never the model's prose).
//   2. Requires an explicit LOCAL gate first: biometric (Face ID / Touch ID /
//      passcode) when available in Expo Go, else a typed-APPROVE fallback.
//   3. Only AFTER the local gate passes: mints a FRESH Arturita step-up session
//      (per approval — never cached/reused) and sends it in the `x-arturita-
//      session` header on the single decide call, exactly as the backend gate
//      expects.
//   4. Handles the 403 / expired-session path gracefully — re-prompt (which
//      re-mints), never a dead-end.
//
// The step-up token lives only inside `submit()` as a local const, is attached to
// the one decide call, and is NEVER logged, stored, or put in a URL.

import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Api, type Approval } from '../api'
import { dangerDetails, probeBiometric, runBiometricGate, typedConfirmationOk, TYPED_CONFIRM_WORD, type BiometricProbe } from '../stepup'
import { font, radius, space, theme } from '../theme'
import { Button, Chip } from '../ui'

type Phase = 'gate' | 'submitting' | 'error'

export default function StepUpModal({
  approval,
  apiUrl,
  orgId,
  getToken,
  onCancel,
  onApproved,
}: {
  approval: Approval
  apiUrl: string
  orgId: string
  getToken: () => Promise<string | null>
  onCancel: () => void
  onApproved: (id: string) => void
}) {
  const d = dangerDetails(approval)
  const [bio, setBio] = useState<BiometricProbe | null>(null) // null → still probing
  const [phase, setPhase] = useState<Phase>('gate')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Probe the biometric gate once on open. Fail-closed to the typed fallback.
  useEffect(() => {
    let alive = true
    probeBiometric().then((b) => {
      if (alive) setBio(b)
    })
    return () => {
      alive = false
    }
  }, [])

  // Mint a FRESH step-up session and decide — runs only after the local gate
  // passes. The token is minted per-approval and discarded here; never cached.
  const submit = useCallback(async () => {
    setPhase('submitting')
    setError(null)
    const token = await getToken()
    if (!token) {
      setError('Not signed in — reconnect and try again.')
      setPhase('error')
      return
    }
    try {
      // Fresh session per approval (respects the backend's 5-min freshness window
      // + single-operator intent). Held only in this local var; never logged.
      const stepUpToken = await Api.mintArturitaSession(apiUrl, token, orgId)
      await Api.decideApproval(apiUrl, token, approval.id, 'approved', undefined, stepUpToken)
      onApproved(approval.id)
    } catch (e: any) {
      const msg = String(e?.message ?? '')
      // A stale/expired step-up (clock skew, or >5 min stalled) surfaces as 403.
      // Re-prompting re-runs the local gate AND re-mints, so recovery is one tap.
      const expired = /\b403\b/.test(msg) || /step-up/i.test(msg)
      setError(
        expired
          ? 'Step-up expired or was rejected. Confirm again to retry.'
          : msg || 'Approval failed. Please try again.',
      )
      setPhase('error')
    }
  }, [apiUrl, orgId, getToken, approval.id, onApproved])

  // Local gate — biometric path. Cancel returns to the gate (no error); an
  // unavailable module downgrades to the typed fallback in place.
  const confirmWithBiometric = useCallback(async () => {
    setPhase('submitting')
    setError(null)
    const res = await runBiometricGate(`Approve: ${d.summary}`)
    if (res.ok) {
      await submit()
      return
    }
    if (res.reason === 'unavailable') {
      setBio({ usable: false, label: '' }) // fall back to typed confirmation
      setPhase('gate')
      return
    }
    if (res.reason === 'cancelled') {
      setPhase('gate')
      return
    }
    setError('Biometric check failed. Try again to confirm.')
    setPhase('error')
  }, [d.summary, submit])

  // Local gate — typed fallback path.
  const confirmWithTyped = useCallback(async () => {
    if (!typedConfirmationOk(typed)) return
    await submit()
  }, [typed, submit])

  const busy = phase === 'submitting'
  const probing = bio === null
  const useTyped = !probing && !bio!.usable

  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? undefined : onCancel}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <ScrollView contentContainerStyle={{ padding: space.lg }}>
            <View style={s.head}>
              <Chip label={d.typeLabel} tone="danger" glyph="⚠" />
              <Text style={s.title}>Confirm dangerous action</Text>
            </View>

            <Text style={s.summary}>{d.summary}</Text>

            {d.warnings.length > 0 ? (
              <View style={s.warnBox}>
                {d.warnings.map((w, i) => (
                  <Text key={i} style={s.warnLine}>
                    ⚠ {w}
                  </Text>
                ))}
              </View>
            ) : null}

            <Text style={s.gateNote}>
              Approving this from your phone requires an on-device step-up. It mints a fresh,
              single-use confirmation session and sends it with the approval — the backend rejects a
              dangerous approve without it.
            </Text>

            {error ? <Text style={s.error}>⚠ {error}</Text> : null}

            {probing ? (
              <View style={s.probe}>
                <ActivityIndicator color={theme.blue} />
                <Text style={s.probeText}>Checking device security…</Text>
              </View>
            ) : useTyped ? (
              <View style={{ marginTop: space.md }}>
                <Text style={s.fallbackNote}>
                  Face ID / Touch ID isn't available on this device, so type {TYPED_CONFIRM_WORD} to
                  confirm. A dev build adds biometric hardening.
                </Text>
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  editable={!busy}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder={TYPED_CONFIRM_WORD}
                  placeholderTextColor={theme.textFaint}
                  style={s.input}
                />
                <Button
                  title={phase === 'error' ? 'Retry' : 'Approve dangerous action'}
                  onPress={confirmWithTyped}
                  tone="danger"
                  busy={busy}
                  disabled={!typedConfirmationOk(typed)}
                />
              </View>
            ) : (
              <View style={{ marginTop: space.md }}>
                <Button
                  title={
                    phase === 'error'
                      ? `Retry — confirm with ${bio!.label}`
                      : `Confirm with ${bio!.label}`
                  }
                  onPress={confirmWithBiometric}
                  tone="danger"
                  busy={busy}
                />
              </View>
            )}

            <View style={{ marginTop: space.sm }}>
              <Button title="Cancel" onPress={onCancel} tone="ghost" disabled={busy} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    backgroundColor: theme.s1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: theme.danger,
    maxHeight: '86%',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  title: { color: theme.text, fontSize: font.lg, fontWeight: '700', flexShrink: 1 },
  summary: { color: theme.text, fontSize: font.base, lineHeight: 22 },
  warnBox: { marginTop: space.md, gap: 3 },
  warnLine: { color: theme.orange, fontSize: font.sm, lineHeight: 19 },
  gateNote: { color: theme.textDim, fontSize: font.sm, lineHeight: 19, marginTop: space.md },
  fallbackNote: { color: theme.textDim, fontSize: font.sm, lineHeight: 19, marginBottom: space.sm },
  error: { color: theme.vermillion, fontSize: font.sm, lineHeight: 19, marginTop: space.md, fontWeight: '600' },
  probe: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg },
  probeText: { color: theme.textDim, fontSize: font.sm },
  input: {
    backgroundColor: theme.s2,
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.md,
    color: theme.text,
    fontSize: font.base,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginBottom: space.md,
  },
})
