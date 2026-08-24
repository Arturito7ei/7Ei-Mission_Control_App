// Inbox / Approvals — the killer remote feature. Lists pending dangerous-action
// approvals and lets the operator approve / reject / request-changes from the
// phone. POST /api/approvals/:id/decide.
//
// MOB-4: approving a *dangerous* type (file_destructive | wallet_tx | email_send
// | machine_exec) is now fully supported from the phone via an on-device STEP-UP
// (StepUpModal): a local biometric/typed gate, then a fresh Arturita command
// session sent in the `x-arturita-session` header exactly as the backend gate
// requires. Reject / request-changes never need step-up and remain one-tap, so
// the remote *stop* action always works.
//
// MOB-7a: this was `InboxScreen`. It is now the Inbox screen's "Inbox" SEGMENT —
// InboxScreen.tsx is the segmented shell (Inbox | Tasks) that hosts it, mirroring
// the web's tabbed Inbox page. THE APPROVAL PATH IS UNCHANGED: load, decide,
// onApprove, confirmReject, the step-up routing and the StepUpModal wiring are
// carried across verbatim from the pre-fold screen. Only the component's name and
// the header comment differ. Nothing about how a dangerous action gets approved
// from this phone moved — that gate is the one thing a layout change must not touch.

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
import {
  KIND_GLYPH, outcomeLabel, activityAgo, activityQuery, type ActivityEvent,
} from '../activityKinds'
import { useAuth } from '../auth'
import { approvalNeedsStepUp } from '../constants'
import { font, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Empty, Loading } from '../ui'
import StepUpModal from './StepUpModal'

/** How many freshly-decided approvals ride under the queue. Small and bounded: this is
 *  a "what did I just decide" tail, not a history view — that is the Activity tab. */
const DECIDED_LIMIT = 10

export default function ApprovalsPane({
  header,
  onRefreshExtra,
}: {
  /** S6 — attention queue rendered above the approvals list (layout hook only). */
  header?: React.ReactNode
  /** S6 — reload attention rows on pull-to-refresh alongside approvals. */
  onRefreshExtra?: () => void | Promise<void>
} = {}) {
  const { apiUrl, getToken, orgId } = useAuth()
  const [items, setItems] = useState<Approval[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // The dangerous approval currently mid-step-up (null = modal closed). MOB-4.
  const [stepUp, setStepUp] = useState<Approval | null>(null)
  // ACT-1 — the recently DECIDED tail, mirroring the desk. Read from the unified
  // activity feed (kind=approval_decided), so the phone and the desk render the SAME
  // server projection of a decided approval rather than two hand-rolled shapes.
  const [decisions, setDecisions] = useState<ActivityEvent[]>([])
  const [now, setNow] = useState(() => Date.now())

  // ACT-1 — the decided tail, on its own so a decision can refresh it without
  // re-reading the pending queue. Deliberately does NOT clear the list on failure: a
  // transient error must not read as "you have decided nothing".
  const loadDecisions = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    try {
      const r = await Api.activity(
        apiUrl, token, orgId,
        activityQuery({ kind: 'approval_decided', limit: DECIDED_LIMIT }),
      )
      setDecisions(r.events ?? [])
      setNow(Date.now())
    } catch {
      /* the queue is the load-bearing part; a missing tail must not blank it */
    }
  }, [apiUrl, getToken, orgId])

  // Pull-to-refresh lands here: TWO cheap bounded reads, no rebuild, no re-crawl.
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
    await onRefreshExtra?.()
    loadDecisions()
  }, [apiUrl, getToken, orgId, loadDecisions, onRefreshExtra])

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
        setItems((cur) => (cur ?? []).filter((x) => x.id !== a.id)) // ONLY on success
        loadDecisions()                                            // re-read what was recorded
      } catch (e: any) {
        setError(e?.message ?? 'Decision failed.')
      } finally {
        setBusyId(null)
      }
    },
    [apiUrl, getToken],
  )

  // Approve. Anything the backend would step-up-gate (a dangerous type OR a
  // non-dangerous outer type carrying payload.requiresStepUp, e.g. a low-trust
  // review wrapping a dangerous action) routes through the on-device step-up modal
  // (MOB-4); truly safe types keep the lightweight one-tap confirm.
  function onApprove(a: Approval) {
    if (approvalNeedsStepUp(a)) {
      // The modal can't mint a session without an org scope. If orgId is briefly
      // null (reconnecting / org not yet resolved), surface it instead of a silent
      // no-op that makes the button look inert.
      if (!orgId) {
        setError('Reconnecting — try again in a moment.')
        return
      }
      setStepUp(a)
      return
    }
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
    <>
    {stepUp && orgId ? (
      <StepUpModal
        approval={stepUp}
        apiUrl={apiUrl}
        orgId={orgId}
        getToken={getToken}
        onCancel={() => setStepUp(null)}
        onApproved={(id) => {
          setStepUp(null)
          setItems((cur) => (cur ?? []).filter((x) => x.id !== id))
          loadDecisions() // ACT-1 — the step-up path confirms too; keep the tail fresh
        }}
      />
    ) : null}
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={items === null} onRefresh={load} tintColor={theme.blue} />
      }
    >
      {header}
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
          // "dangerous" here = the backend would step-up-gate approving it (a
          // dangerous type OR payload.requiresStepUp) — so the chip, the "step-up"
          // Approve label, and the note all read honestly for a wrapped case too.
          const dangerous = approvalNeedsStepUp(a)
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
                  {/* MOB-4: dangerous approvals are now approvable from the phone —
                      the tap opens the on-device step-up modal (biometric/typed gate
                      → fresh session → x-arturita-session header). Safe types keep the
                      one-tap confirm. Reject/revision never step up. */}
                  <Button
                    title={dangerous ? 'Approve — step-up' : 'Approve'}
                    onPress={() => onApprove(a)}
                    tone="ok"
                    busy={busy}
                  />
                </View>
                <View style={s.actionBtn}>
                  <Button title="Reject" onPress={() => confirmReject(a)} tone="danger" busy={busy} />
                </View>
              </View>
              {dangerous ? (
                <Text style={s.stepup}>
                  ⚠ Approving this dangerous action requires an on-device step-up (Face ID / Touch ID,
                  or a typed confirmation). Reject or request changes here without it.
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

      {/* ACT-1 — RECENTLY DECIDED. Its own heading rather than mixed into the queue,
          because telling "needs a decision now" apart from "already answered" is the
          whole job of this screen. Read-only by design: an answered approval carries no
          buttons, so there is nothing here to decide twice. Rows come from the server's
          projection — no payload, no decision note. */}
      {decisions.length > 0 ? (
        <View style={{ marginTop: space.lg }}>
          <Text style={s.decidedHead}>Recently decided · already handled</Text>
          {decisions.map((d) => (
            <Card key={d.id} style={[s.decidedCard, { marginBottom: space.xs }]}>
              <View style={s.decidedRow}>
                <Text style={s.decidedGlyph}>{KIND_GLYPH.approval_decided}</Text>
                <Text style={s.decidedTitle} numberOfLines={2}>
                  {d.title}
                </Text>
                <Chip
                  label={outcomeLabel(d.kind, d.outcome)}
                  tone={d.outcome === 'ok' ? 'ok' : d.outcome === 'rejected' ? 'danger' : 'neutral'}
                />
              </View>
              <View style={s.decidedMeta}>
                {d.target ? <Text style={s.decidedTarget}>{d.target}</Text> : null}
                {d.agentName ? <Text style={s.decidedTarget}>{d.agentName}</Text> : null}
                <Text style={s.decidedTarget}>{activityAgo(d.at, now)}</Text>
              </View>
            </Card>
          ))}
        </View>
      ) : null}
    </ScrollView>
    </>
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
  // ACT-1 — the recently-decided tail.
  //
  // AUDIT-ACT1 UX-2 (mirrored from the desk) — DE-EMPHASISED on purpose. It first shipped
  // with the same card chrome, row height and font as a pending approval, so a quiet
  // queue read as mostly "already handled" and the eye had nothing to lock onto. On a
  // phone that is worse than on the desk: there is no peripheral vision to fall back on,
  // the whole screen is the list. Answered work is reference material — quieter, denser,
  // flatter. Still fully readable: de-emphasis, not hiding.
  decidedHead: {
    color: theme.textFaint,
    fontSize: font.sm - 1,
    fontWeight: '600',
    marginBottom: space.sm,
  },
  decidedCard: {
    backgroundColor: 'transparent',
    borderColor: theme.s3,
    paddingVertical: space.sm,
  },
  decidedRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  decidedGlyph: { fontSize: font.sm, opacity: 0.7 },
  decidedTitle: { flex: 1, color: theme.textDim, fontSize: font.sm - 1, fontWeight: '500' },
  decidedMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginTop: space.xs,
  },
  decidedTarget: { color: theme.textFaint, fontSize: font.sm - 1 },
})
