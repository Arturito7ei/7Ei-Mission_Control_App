// Connection status — proves the phone is talking to the hosted backend. Shows
// /api/health (db, scheduler, version) and the org this session is scoped to.

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api, type Health } from '../api'
import { useAuth } from '../auth'
import { font, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Loading } from '../ui'

export default function HealthScreen() {
  const { apiUrl, orgName, orgId, signOut, authMode, identityLabel } = useAuth()
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setError(null)
    try {
      setHealth(await Api.health(apiUrl))
    } catch (e: any) {
      setError(e?.message ?? 'Failed')
      setHealth(null)
    } finally {
      setLoading(false)
    }
  }, [apiUrl])

  useEffect(() => {
    load()
  }, [load])

  const dbOk = health?.db === 'connected'
  const unhealthy = health?.llm?.unhealthy ?? []

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.blue} />}
    >
      {loading && !health ? (
        <Loading text="Contacting the backend…" />
      ) : error ? (
        <Banner kind="error">{error}</Banner>
      ) : health ? (
        <>
          <Card>
            <View style={s.row}>
              <Text style={s.h}>Backend</Text>
              <Chip
                label={health.status === 'ok' ? 'ONLINE' : health.status.toUpperCase()}
                tone={health.status === 'ok' ? 'ok' : 'danger'}
                glyph={health.status === 'ok' ? '✓' : '⚠'}
              />
            </View>
            <Text style={s.dim}>{apiUrl}</Text>
            <View style={s.kv}>
              <Kv k="Database" v={health.db ?? '—'} tone={dbOk ? 'ok' : 'danger'} glyph={dbOk ? '✓' : '⚠'} />
              <Kv k="Scheduler" v={health.scheduler ?? '—'} />
              <Kv k="Version" v={health.version ?? '—'} />
            </View>
          </Card>

          <Card style={{ marginTop: space.lg }}>
            <Text style={s.h}>LLM providers</Text>
            {(health.llm?.providers ?? []).length === 0 ? (
              <Text style={s.dim}>No provider status reported.</Text>
            ) : (
              <View style={s.chips}>
                {health.llm!.providers!.map((p) => (
                  <Chip
                    key={p.key}
                    label={p.key}
                    tone={p.healthy ? 'ok' : 'warn'}
                    glyph={p.healthy ? '✓' : '•'}
                  />
                ))}
              </View>
            )}
            {unhealthy.length > 0 ? (
              <Text style={[s.dim, { marginTop: space.sm }]}>Unhealthy: {unhealthy.join(', ')}</Text>
            ) : null}
          </Card>

          <Card style={{ marginTop: space.lg }}>
            <Text style={s.h}>Session</Text>
            <Kv k="Org" v={orgName ?? orgId ?? '—'} />
            <Kv k="Auth" v={authMode === 'clerk' ? 'Clerk (auto-refresh)' : authMode === 'paste' ? 'Pasted token' : '—'} />
            {identityLabel ? <Kv k="Signed in as" v={identityLabel} /> : null}
            <View style={{ marginTop: space.md }}>
              <Button title={authMode === 'clerk' ? 'Sign out' : 'Disconnect'} onPress={signOut} tone="ghost" />
            </View>
          </Card>
        </>
      ) : null}
    </ScrollView>
  )
}

function Kv({
  k,
  v,
  tone,
  glyph,
}: {
  k: string
  v: string
  tone?: 'ok' | 'danger'
  glyph?: string
}) {
  const color = tone === 'ok' ? theme.green : tone === 'danger' ? theme.vermillion : theme.text
  return (
    <View style={s.kvRow}>
      <Text style={s.kvK}>{k}</Text>
      <Text style={[s.kvV, { color }]}>
        {glyph ? `${glyph} ` : ''}
        {v}
      </Text>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h: { color: theme.text, fontSize: font.lg, fontWeight: '700' },
  dim: { color: theme.textDim, fontSize: font.sm, marginTop: space.xs },
  kv: { marginTop: space.md },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space.xs,
  },
  kvK: { color: theme.textDim, fontSize: font.base },
  kvV: { color: theme.text, fontSize: font.base, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
})
