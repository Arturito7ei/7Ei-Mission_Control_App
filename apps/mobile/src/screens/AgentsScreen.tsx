// Agents — the roster, read-only. GET /api/orgs/:orgId/agents. Shows each agent's
// name, role, runtime, LLM, status, and heartbeat (heartbeat + status are shown
// with a label + glyph, never color alone).

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api, type Agent } from '../api'
import { useAuth } from '../auth'
import { font, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'

function heartbeatTone(h?: string | null): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (h === 'green') return 'ok'
  if (h === 'amber') return 'warn'
  if (h === 'stale') return 'danger'
  return 'neutral'
}

export default function AgentsScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      setAgents(await Api.agents(apiUrl, token, orgId))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load agents.')
      setAgents([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={agents === null} onRefresh={load} tintColor={theme.blue} />
      }
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {agents === null ? (
        <Loading text="Loading agents…" />
      ) : agents.length === 0 ? (
        <Empty text="No agents in this organisation yet." />
      ) : (
        agents.map((a) => (
          <Card key={a.id} style={{ marginBottom: space.md }}>
            <View style={s.head}>
              <Text style={s.avatar}>{a.avatarEmoji || '🤖'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{a.name}</Text>
                {a.role ? <Text style={s.role}>{a.role}</Text> : null}
              </View>
              <Chip
                label={(a.status || 'unknown').toUpperCase()}
                tone={a.status === 'active' ? 'ok' : a.status === 'paused' ? 'warn' : 'neutral'}
                glyph={a.status === 'active' ? '●' : '○'}
              />
            </View>
            <View style={s.tags}>
              {a.runtime ? <Chip label={a.runtime} tone="info" /> : null}
              {a.llmModel ? <Chip label={a.llmModel} tone="neutral" /> : null}
              {a.trustMode === 'low_trust_review' ? (
                <Chip label="low-trust" tone="warn" glyph="⚠" />
              ) : null}
              <Chip
                label={`heartbeat: ${a.heartbeatStatus || 'unknown'}`}
                tone={heartbeatTone(a.heartbeatStatus)}
                glyph={a.heartbeatStatus === 'green' ? '✓' : '•'}
              />
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { fontSize: 28 },
  name: { color: theme.text, fontSize: font.lg, fontWeight: '700' },
  role: { color: theme.textDim, fontSize: font.sm, marginTop: 2 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
})
