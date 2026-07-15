// Inbox / Approvals — the killer remote feature. Lists pending dangerous-action
// approvals and lets the operator approve / reject / request-changes from the
// phone. POST /api/approvals/:id/decide.
//
// Honest note: approving a *dangerous* type (file_destructive | wallet_tx |
// email_send | machine_exec) requires a fresh Arturita step-up session token,
// which this phase-1 client does not mint — so approve may 403 with a clear
// "step-up required" message. Reject / request-changes never need step-up, so the
// remote *stop* action always works. Step-up on mobile is story MOB-4.

import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Api, type Approval } from '../api'
import { useAuth } from '../auth'
import { isDangerousApprovalType } from '../constants'
import { font, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Empty, Loading } from '../ui'

export default function InboxScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [items, setItems] = useState<Approval[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      setItems(await Api.pendingApprovals(apiUrl, token, orgId))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load approvals.')
      setItems([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const decide = useCallback(
    async (a: Approval, decision: 'approved' | 'rejected' | 'revision_requested', note?: string) => {
      const token = await getToken()
      if (!token) return
      setBusyId(a.id)
      setError(null)
      try {
        await Api.decideApproval(apiUrl, token, a.id, decision, note)
        setItems((cur) => (cur ?? []).filter((x) => x.id !== a.id))
      } catch (e: any) {
        setError(e?.message ?? 'Decision failed.')
      } finally {
        setBusyId(null)
      }
    },
    [apiUrl, getToken],
  )

  // Only reached for NON-dangerous approvals: dangerous ones disable Approve (L1),
  // because one-tap approve of them always 403s until on-device step-up (MOB-4).
  function confirmApprove(a: Approval) {
    Alert.alert('Approve?', a.summary || a.type, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', onPress: () => decide(a, 'approved') },
    ])
  }

  function confirmReject(a: Approval) {
    Alert.alert('Reject?', a.summary || a.type, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => decide(a, 'rejected') },
    ])
  }

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={items === null} onRefresh={load} tintColor={theme.blue} />
      }
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {items === null ? (
        <Loading text="Loading approvals…" />
      ) : items.length === 0 ? (
        <Empty text="No pending approvals. You're all caught up." />
      ) : (
        items.map((a) => {
          const dangerous = isDangerousApprovalType(a.type)
          const busy = busyId === a.id
          return (
            <Card key={a.id} style={{ marginBottom: space.lg }}>
              <View style={s.head}>
                <Chip
                  label={a.type.replace(/_/g, ' ')}
                  tone={dangerous ? 'danger' : 'warn'}
                  glyph={dangerous ? '⚠' : '•'}
                />
                {a.createdAt ? <Text style={s.when}>{ago(a.createdAt)}</Text> : null}
              </View>
              <Text style={s.summary}>{a.summary || '(no summary provided)'}</Text>
              {a.requestedByAgentId ? (
                <Text style={s.meta}>from agent {a.requestedByAgentId.slice(0, 8)}…</Text>
              ) : null}

              <View style={s.actions}>
                <View style={s.actionBtn}>
                  {/* L1: dangerous approvals can't be one-tap approved from the phone
                      yet — approve needs a step-up session token (MOB-4), so a plain
                      Approve tap would always 403. Disable + relabel it so the UX is
                      honest instead of a dead-end tap. Reject/revision never step up. */}
                  <Button
                    title={dangerous ? 'Approve — step-up' : 'Approve'}
                    onPress={() => confirmApprove(a)}
                    tone="ok"
                    busy={busy}
                    disabled={dangerous}
                  />
                </View>
                <View style={s.actionBtn}>
                  <Button title="Reject" onPress={() => confirmReject(a)} tone="danger" busy={busy} />
                </View>
              </View>
              {dangerous ? (
                <Text style={s.stepup}>
                  ⚠ Approving this dangerous action needs an on-device step-up session (MOB-4). Reject
                  or request changes from here — those always work.
                </Text>
              ) : null}
              <View style={{ marginTop: space.sm }}>
                <Button
                  title="Request changes"
                  onPress={() => decide(a, 'revision_requested', 'Please revise (sent from mobile).')}
                  tone="ghost"
                  busy={busy}
                />
              </View>
            </Card>
          )
        })
      )}
    </ScrollView>
  )
}

function ago(ms: number): string {
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  when: { color: theme.textFaint, fontSize: font.sm },
  summary: { color: theme.text, fontSize: font.base, lineHeight: 21, marginTop: space.md },
  meta: { color: theme.textDim, fontSize: font.sm, marginTop: space.xs },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  actionBtn: { flex: 1 },
  stepup: {
    color: theme.orange,
    fontSize: font.sm,
    lineHeight: 18,
    marginTop: space.sm,
  },
})
