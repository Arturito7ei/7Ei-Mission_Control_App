// Agents — the roster, read-only. GET /api/orgs/:orgId/agents. Shows each agent's
// name, role, runtime, LLM, status, and heartbeat (heartbeat + status are shown
// with a label + glyph, never color alone).
//
// MOB-6b: a row now OPENS that agent (AgentDetailScreen), which is what the web
// has always done from its roster — until this story the phone's roster was a
// dead end. The push itself is the navigator's (`onOpenAgent`), so this screen
// still knows nothing about routing.
//
// MOB-6d: both chips below now go through status.ts, like every other surface.
// They used to hand-roll their own mapping here, and it had drifted from the
// canonical table in three ways at once — the roster and the detail screen were
// describing the same agent differently:
//
//   * STATUS compared `=== 'active'` literally, so the aliases the table exists
//     to collapse never landed: a `running` agent fell through to the ○/neutral
//     "idle" chip on the roster while the detail screen (via statusIcon) showed
//     it as ⬡/active. Same agent, two states, depending on which screen you were
//     looking at. `failed`/`stopped`/`terminated` all read as plain idle too —
//     the roster could not show you a dead agent.
//   * The GLYPHS were invented here (●/○), so even where the two agreed on the
//     state they disagreed on the mark. ● vs ⬡ is not a style difference when the
//     glyph IS the signal that survives colorblindness.
//   * The local `heartbeatTone` mapped green→'ok' (green chip), but the web maps
//     an active heartbeat to the ACCENT, not green — a deliberate DESIGN_SYSTEM
//     v2 rule, since green/red is the pair the operator can't see. status.ts's
//     `heartbeatTone` carries that rule; this one quietly undid it.
//
// Heartbeats keep their own helpers (`heartbeatIcon`/`heartbeatTone`) rather than
// being passed to `statusIcon`/`statusTone`: green/amber/stale is a SEPARATE
// vocabulary, and only HEARTBEAT_STATUS bridges the two. status.ts spells out why
// mixing them silently turns a healthy agent into an idle one.

import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api, type Agent } from '../api'
import { useAuth } from '../auth'
import { heartbeatIcon, heartbeatTone, statusIcon, statusTone } from '../status'
import { font, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'

export default function AgentsScreen({ onOpenAgent }: { onOpenAgent?: (id: string, name?: string) => void }) {
  const { apiUrl, getToken, orgId } = useAuth()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
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
          <Pressable
            key={a.id}
            accessibilityRole={onOpenAgent ? 'button' : undefined}
            accessibilityLabel={onOpenAgent ? `${a.name} — open agent details` : undefined}
            onPress={onOpenAgent ? () => onOpenAgent(a.id, a.name) : undefined}
            style={({ pressed }) => [{ marginBottom: space.md }, pressed && onOpenAgent && { opacity: 0.7 }]}
          >
            <Card>
              <View style={s.head}>
                <Text style={s.avatar}>{a.avatarEmoji || '🤖'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{a.name}</Text>
                  {a.role ? <Text style={s.role}>{a.role}</Text> : null}
                </View>
                <Chip
                  label={(a.status || 'unknown').toUpperCase()}
                  tone={statusTone(a.status)}
                  glyph={statusIcon(a.status)}
                />
                {/* The affordance a phone list needs: a row that opens something
                    says so. Hidden from the a11y tree — the row's own label
                    already says "open agent details". */}
                {onOpenAgent ? (
                  <Text accessibilityElementsHidden importantForAccessibility="no" style={s.chevron}>
                    ›
                  </Text>
                ) : null}
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
                  glyph={heartbeatIcon(a.heartbeatStatus)}
                />
              </View>
            </Card>
          </Pressable>
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
  chevron: { color: theme.textFaint, fontSize: font.lg, fontWeight: '700' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
})
