// MOB-6f — Governance. READ-ONLY, replacing the `governance` placeholder.
//
// MIRRORS the web's `governance` surface (web/app/dashboard/GovernancePanel.tsx)
// over the same calls:
//
//   GET /api/orgs/:orgId/policies   → { policies }   execution policies
//   GET /api/orgs/:orgId/agents     → { agents }     permissions + trust, inline
//   GET /api/orgs/:orgId/revisions  → { revisions }  config history
//
// The web loads a fourth, `…/available-models`, purely to fill the model-profile
// <select>. The phone has no select to fill, so it doesn't ask.
//
// WHAT CARRIES OVER: all four readings — which actions need approval, what each
// agent may do, how contained each agent is, and what changed lately. That is
// the whole "is my org still fenced in the way I left it?" question, and it's
// exactly what you want to answer from a phone.
//
// WHAT'S DEFERRED — every write, deliberately and without exception:
//   * Add policy / Remove policy          (POST …/policies, DELETE /api/policies/:id)
//   * Save per-agent permissions          (PATCH /api/agents/:id/permissions)
//   * Change trust tier + boundary set    (PUT …/agents/:id/trust — OWNER-ONLY)
//   * Change model profile                (PUT …/agents/:id/model-profile)
//   * Roll back a revision                (POST /api/revisions/:id/rollback)
//
// WHY, precisely: this surface decides what an agent is ALLOWED TO DO. Every
// control above is destructive-by-mis-tap in a way no other mobile screen is —
// "Remove" next to a policy, a one-tap rollback, a trust tier one scroll-flick
// from Standard to Low-trust. None of them has an undo, and several are
// owner-only for that reason. The reading carries none of that risk and all of
// the value away from a desk. Deferred to a later story — parity doc §6.7 — not
// dropped, and the screen says so out loud rather than showing dead controls.
//
// NOTHING SENSITIVE IS RENDERED. Policies are action names, permissions are
// capability strings, boundaries are counted (not listed — the ids are noise on
// a phone), revisions are entity + actor + age. No secret, no token, no value.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import {
  CAP_HINTS,
  GOVERNANCE_READONLY_NOTE,
  REVISION_DISPLAY_LIMIT,
  boundaryLine,
  capsLabel,
  isContainedToNothing,
  parseBoundary,
  policyBadge,
  revisionRows,
  revisionSubtitle,
  revisionTitle,
  trustBadge,
  type GovAgentLite,
  type PolicyLite,
  type RevisionLite,
} from '../governance'
import { font, radius, space, theme } from '../theme'
import { Banner, Card, Empty, Loading } from '../ui'

const TONE_COLOR = {
  warn: theme.orange,
  muted: theme.textFaint,
  ok: theme.green,
} as const

function SectionLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <View style={s.sectionHead}>
      <Text accessibilityRole="header" style={s.sectionLabel}>
        {children}
      </Text>
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  )
}

/** Glyph + word + tone. The word carries the meaning; colour only decorates. */
function Badge({ icon, label, tone }: { icon: string; label: string; tone: keyof typeof TONE_COLOR }) {
  const color = TONE_COLOR[tone]
  return (
    <View style={[s.badge, { borderColor: color }]}>
      <Text style={[s.badgeText, { color }]}>
        {icon} {label}
      </Text>
    </View>
  )
}

function PolicyRow({ policy }: { policy: PolicyLite }) {
  const b = policyBadge(policy)
  return (
    <View style={s.row} accessibilityLabel={`Policy ${policy.action}: ${b.label}`}>
      <Text style={s.mono} numberOfLines={1}>
        {policy.action}
      </Text>
      <Badge {...b} />
    </View>
  )
}

function AgentGovRow({ agent }: { agent: GovAgentLite }) {
  const caps = capsLabel(agent.permissions)
  const boundary = parseBoundary(agent.trustBoundary)
  const trust = trustBadge(agent.trustMode)
  const stranded = isContainedToNothing(agent.trustMode, boundary)
  return (
    <View style={s.agentRow}>
      <View style={s.agentHead}>
        <Text style={s.avatar}>{agent.avatarEmoji || '🤖'}</Text>
        <Text style={s.agentName} numberOfLines={1}>
          {agent.name}
        </Text>
        <Badge {...trust} />
      </View>

      {/* "Allow all" is a STATE, not a blank — see capsLabel. An empty list here
          means unrestricted, and saying "none" would be a dangerous lie. */}
      <View style={s.kv}>
        <Text style={s.k}>Permissions</Text>
        <Text
          style={[s.v, caps.allowAll && { color: theme.orange }]}
          accessibilityLabel={
            caps.allowAll
              ? `${agent.name} permissions: allow all — unrestricted`
              : `${agent.name} permissions: ${caps.caps.join(', ')}`
          }
        >
          {caps.allowAll ? '⚠ Allow all (unrestricted)' : caps.label}
        </Text>
      </View>

      {/* Only meaningful when contained — a Standard agent has no boundary set. */}
      {trust.tone === 'warn' ? (
        <View style={s.kv}>
          <Text style={s.k}>Boundary</Text>
          <Text style={s.v}>{boundaryLine(boundary)}</Text>
        </View>
      ) : null}

      {stranded ? (
        <Text style={s.stranded}>
          ⚠ Empty boundary — this agent can touch nothing (fully contained).
        </Text>
      ) : null}
    </View>
  )
}

function RevisionRow({ revision, now }: { revision: RevisionLite; now: number }) {
  return (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.revTitle} numberOfLines={1}>
          {revisionTitle(revision)}
        </Text>
        <Text style={s.revSub} numberOfLines={1}>
          {revisionSubtitle(revision, now)}
        </Text>
      </View>
    </View>
  )
}

export default function GovernanceScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [policies, setPolicies] = useState<PolicyLite[] | null>(null)
  const [agents, setAgents] = useState<GovAgentLite[] | null>(null)
  const [revisions, setRevisions] = useState<RevisionLite[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One clock per load, not one per row — so every age on screen is consistent
  // and the list doesn't re-render itself into a new "now" mid-scroll.
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      // All three in parallel, as the web does. One failing section shouldn't
      // blank the other two, so each settles on its own — but a total failure
      // (dead backend, bad token) still surfaces as one honest banner.
      const [p, a, r] = await Promise.all([
        Api.policies(apiUrl, token, orgId).catch(() => null),
        Api.governanceAgents(apiUrl, token, orgId).catch(() => null),
        Api.revisions(apiUrl, token, orgId).catch(() => null),
      ])
      if (p === null && a === null && r === null) {
        throw new Error('Could not load governance — the backend is unreachable or the token is invalid.')
      }
      setNow(Date.now())
      setPolicies(p ?? [])
      setAgents(a ?? [])
      setRevisions(r ?? [])
      if (p === null || a === null || r === null) {
        const failed = [p === null && 'policies', a === null && 'agents', r === null && 'revisions']
          .filter(Boolean)
          .join(', ')
        setError(`Some sections failed to load (${failed}). Pull to refresh.`)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load governance.')
      setPolicies([])
      setAgents([])
      setRevisions([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const revRows = useMemo(() => (revisions ? revisionRows(revisions) : []), [revisions])
  const loading = policies === null && agents === null && revisions === null

  if (loading) return <Loading text="Loading governance…" />

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={theme.blue} />}
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {/* The promise, stated before the operator hunts for a Save button. */}
      <Banner kind="info">{GOVERNANCE_READONLY_NOTE}</Banner>

      <SectionLabel hint="Actions held for your review before they take effect.">
        Execution policies
      </SectionLabel>
      <Card>
        {policies && policies.length > 0 ? (
          policies.map((p) => <PolicyRow key={p.id} policy={p} />)
        ) : (
          <Empty text="No execution policies." />
        )}
      </Card>

      <SectionLabel hint={`Capabilities each agent may use. Empty = allow all. Wildcards: ${CAP_HINTS.join('  ·  ')}`}>
        Per-agent permissions
      </SectionLabel>
      <Card>
        {agents && agents.length > 0 ? (
          agents.map((a) => <AgentGovRow key={a.id} agent={a} />)
        ) : (
          <Empty text="No agents." />
        )}
      </Card>

      <SectionLabel hint="Trust tier is owner-only, and changing it stays on the desktop.">
        Trust &amp; containment
      </SectionLabel>
      <Card>
        <Text style={s.body}>
          A <Text style={s.strong}>low-trust</Text> agent is contained: it may only touch the
          resources in its boundary set, and every gated action — file_destructive, wallet_tx,
          email_send, machine_exec, create-agents/skills, assign-tasks — is held for review before it
          takes effect. Default is <Text style={s.strong}>Standard</Text>.
        </Text>
        <Text style={s.bodyDim}>
          Each agent’s current tier and boundary is shown with it under Per-agent permissions above.
        </Text>
      </Card>

      <SectionLabel
        hint={
          revisions && revisions.length > REVISION_DISPLAY_LIMIT
            ? `Newest ${REVISION_DISPLAY_LIMIT} of ${revisions.length}. Rollback stays on the desktop.`
            : 'Rollback stays on the desktop.'
        }
      >
        Config revisions
      </SectionLabel>
      <Card>
        {revRows.length > 0 ? (
          revRows.map((r) => <RevisionRow key={r.id} revision={r} now={now} />)
        ) : (
          <Empty text="No config revisions yet." />
        )}
      </Card>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  sectionHead: { gap: 2, marginTop: space.sm },
  sectionLabel: {
    color: theme.text,
    fontSize: font.sm,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  hint: { color: theme.textDim, fontSize: font.sm - 1, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.s3,
  },
  mono: {
    flex: 1,
    color: theme.text,
    fontSize: font.sm,
    fontFamily: 'Menlo',
  },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  badgeText: { fontSize: font.sm - 2, fontWeight: '700' },
  agentRow: {
    paddingVertical: space.md,
    gap: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.s3,
  },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatar: { fontSize: 18 },
  agentName: { flex: 1, color: theme.text, fontSize: font.base, fontWeight: '700' },
  kv: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  k: { width: 92, color: theme.textFaint, fontSize: font.sm - 1, fontWeight: '600' },
  v: { flex: 1, color: theme.textDim, fontSize: font.sm - 1, lineHeight: 18 },
  stranded: { color: theme.orange, fontSize: font.sm - 1, marginTop: 2 },
  revTitle: { color: theme.text, fontSize: font.sm, fontWeight: '600' },
  revSub: { color: theme.textFaint, fontSize: font.sm - 2, marginTop: 1 },
  body: { color: theme.textDim, fontSize: font.sm, lineHeight: 19 },
  bodyDim: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 18, marginTop: space.sm },
  strong: { color: theme.text, fontWeight: '700' },
})
