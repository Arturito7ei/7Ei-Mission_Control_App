// MOB-6f — Settings. READ-ONLY, replacing the `settings` placeholder.
//
// MIRRORS the web's `settings` surface (web/app/dashboard/page.tsx,
// `tab === 'settings'`) over the same source:
//
//   GET /api/orgs → { orgs: [...] }   — the org carries the three fields
//
// HONEST SCOPE: the web's Settings tab is a FORM. Three inputs (Description,
// Mission & Vision, Culture & Principles), a per-field upload chip that
// summarises a document into that field, and Save. Its only READING is the
// current value of those three fields. So this screen is short because the web
// surface is short on readings — not because we trimmed it, and we did not pad
// it to look like a peer of Governance. Mission and Culture are read by every
// agent, so "what did we tell them we are?" is a real question to answer from a
// phone; that's the whole screen, honestly.
//
// WHAT'S DEFERRED — the form:
//   * Editing the three fields   (PATCH /api/orgs/:id)
//   * The document summarise     (POST …/knowledge/ingest-file, multipart)
// Deferred, not dropped — parity doc §6.7.
//
// ⚠ WHY THIS SCREEN IS AN ALLOW-LIST AND NOT A LOOP OVER THE ORG.
// `GET /api/orgs` is `db.select().from(organisations)` — the WHOLE row — and
// that row has a `telegramBotToken` column. The phone has received that payload
// since MOB-1 (ConnectScreen lists orgs); MOB-6f doesn't change it, and
// narrowing the backend projection is out of scope for an apps/mobile-only
// story (reported as a follow-up). What this screen owes is that NONE of it
// reaches a pixel: it renders `SETTINGS_FIELDS` — a fixed allow-list of three
// prose fields — and never spreads the org, never walks its keys, never logs it.
// `settings.test.ts` asserts the hazard column exists AND that the allow-list
// excludes it, so this can't rot quietly.
//
// SECRETS ARE NOT SHOWN HERE ON ANY CLIENT. The nav model lists `secrets` as a
// tab "hosted" on Settings, but the web's Settings tab does not render it — the
// Secrets surface is its own thing, fed by `…/secrets`, inside the Cockpit
// shell. It is not in this story, and this screen reads nothing from it.

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import {
  SETTINGS_FIELDS,
  SETTINGS_READONLY_NOTE,
  SETTINGS_SCOPE_NOTE,
  fieldValue,
  findOrg,
  type OrgSettingsLite,
} from '../settings'
import { font, space, theme } from '../theme'
import { Banner, Card, Empty, Loading } from '../ui'

export default function SettingsScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [org, setOrg] = useState<OrgSettingsLite | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      const orgs = await Api.orgSettings(apiUrl, token)
      const found = findOrg(orgs, orgId)
      setOrg(found)
      // The session is scoped to an org the list doesn't contain — say so rather
      // than rendering three empty fields as if the org had nothing set.
      setMissing(found === null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load settings.')
      setOrg(null)
      setMissing(false)
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  if (org === null && !missing && !error) return <Loading text="Loading settings…" />

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={theme.blue} />}
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {/* The promise, stated before the operator hunts for an input. */}
      <Banner kind="info">{SETTINGS_READONLY_NOTE}</Banner>

      {missing ? (
        <Empty text="This session’s organisation wasn’t in the list your token can see. Re-connect from Status." />
      ) : org ? (
        <>
          <Card>
            <Text style={s.orgLabel}>Organisation</Text>
            <Text style={s.orgName}>{org.name}</Text>
          </Card>

          {/* An ALLOW-LIST, deliberately — never a loop over the org object. */}
          {SETTINGS_FIELDS.map((f) => {
            const value = fieldValue(org, f.key)
            return (
              <View key={f.key} style={s.field}>
                <Text accessibilityRole="header" style={s.label}>
                  {f.label}
                </Text>
                <Card>
                  <Text style={[s.value, !value && s.empty]}>{value ?? f.empty}</Text>
                </Card>
              </View>
            )
          })}

          <Text style={s.note}>{SETTINGS_SCOPE_NOTE}</Text>
        </>
      ) : null}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  orgLabel: {
    color: theme.textFaint,
    fontSize: font.sm - 2,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  orgName: { color: theme.text, fontSize: font.lg, fontWeight: '800', marginTop: 2 },
  field: { gap: space.sm },
  label: {
    color: theme.text,
    fontSize: font.sm,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  value: { color: theme.text, fontSize: font.base, lineHeight: 21 },
  empty: { color: theme.textFaint, fontStyle: 'italic' },
  note: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 18, marginTop: space.sm },
})
