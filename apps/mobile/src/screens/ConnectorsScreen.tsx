// MOB-6f — Connectors. READ-ONLY, replacing the `connectors` placeholder.
//
// MIRRORS the web's `connectors` surface (web/app/dashboard/ConnectorsPanel.tsx)
// over the same call:
//
//   GET /api/orgs/:orgId/connectors → { connectors }
//
// The backend merges its registry with the org's live status, so this one call
// answers the only question the phone asks: WHAT IS ATTACHED RIGHT NOW.
//
// WHAT CARRIES OVER: the connector list, grouped by category in the web's order,
// each with its connected/disconnected status and its account label.
//
// WHAT'S DEFERRED — every write:
//   * Connect (POST …/connectors/:id/connect). For token/basic connectors this
//     is a CREDENTIAL FORM; this app never asks you to type a secret, so it has
//     no business growing one here. For Google it's an OAuth bounce through
//     `window.location` to a consent screen — there is no window to redirect,
//     and an in-app OAuth flow is a dev-build-shaped problem, not an Expo Go one.
//   * Test (POST …/test), Disconnect (DELETE …/:id), token rotation, the Google
//     per-service toggles, and the gear sheets (Google scope; vault repo/root/
//     branch) — all writes, all PUT/POST/DELETE.
//   * The Jira issue peek (`…/jira/issues`) — a GET, but it belongs to the web's
//     Jira card, not to "what's connected"; it's a different screen's job.
//
// Deferred, not dropped — parity doc §6.7. The screen says where connecting
// happens rather than showing a button that can't work.
//
// NO CREDENTIAL IS RENDERED, AND NONE IS FETCHED. `detail` is an account label
// by the backend's construction: the GitHub/HF account name, `email · domain
// (KEY)` for Jira, `repo · root/ (branch)` for the vault. The credential itself
// never leaves the encrypted secret store, and this screen doesn't even carry
// the registry's `secretKey` (the storage key's NAME) in its row type.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import {
  CONNECTORS_READONLY_NOTE,
  connectedBadge,
  connectedSummary,
  connectorGroups,
  detailLine,
  type ConnectorRowLite,
} from '../connectors'
import { font, radius, space, theme } from '../theme'
import { Banner, Card, Empty, Loading } from '../ui'

const TONE_COLOR = { ok: theme.green, neutral: theme.textFaint } as const

function ConnectorRow({ row }: { row: ConnectorRowLite }) {
  const badge = connectedBadge(row)
  const color = TONE_COLOR[badge.tone]
  return (
    <View
      style={s.row}
      accessibilityLabel={`${row.name}: ${badge.label}. ${detailLine(row)}`}
    >
      <Text style={s.icon}>{row.icon}</Text>
      <View style={s.body}>
        <Text style={s.name} numberOfLines={1}>
          {row.name}
        </Text>
        {/* The account label — never a credential. See the header note. */}
        <Text style={s.detail} numberOfLines={1}>
          {detailLine(row)}
        </Text>
      </View>
      {/* Glyph + word carry the status; the colour only decorates it. */}
      <View style={[s.badge, { borderColor: color }]}>
        <Text style={[s.badgeText, { color }]}>
          {badge.icon} {badge.label}
        </Text>
      </View>
    </View>
  )
}

export default function ConnectorsScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [rows, setRows] = useState<ConnectorRowLite[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      setRows(await Api.connectors(apiUrl, token, orgId))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load connectors.')
      setRows([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  const groups = useMemo(() => (rows ? connectorGroups(rows) : []), [rows])

  if (rows === null) return <Loading text="Loading connectors…" />

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={theme.blue} />}
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {rows.length > 0 ? <Text style={s.summary}>{connectedSummary(rows)}</Text> : null}

      {/* The promise, stated before the operator hunts for a Connect button. */}
      <Banner kind="info">{CONNECTORS_READONLY_NOTE}</Banner>

      {groups.length === 0 ? (
        <Empty text="No connectors available." />
      ) : (
        groups.map((g) => (
          <View key={g.category} style={s.group}>
            <Text accessibilityRole="header" style={s.category}>
              {g.category}
            </Text>
            <Card>
              {g.rows.map((r) => (
                <ConnectorRow key={r.id} row={r} />
              ))}
            </Card>
          </View>
        ))
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  summary: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  group: { gap: space.sm },
  category: {
    color: theme.text,
    fontSize: font.sm,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.s3,
  },
  icon: { fontSize: 22 },
  body: { flex: 1, gap: 2 },
  name: { color: theme.text, fontSize: font.base, fontWeight: '700' },
  detail: { color: theme.textDim, fontSize: font.sm - 1 },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  badgeText: { fontSize: font.sm - 2, fontWeight: '700' },
})
