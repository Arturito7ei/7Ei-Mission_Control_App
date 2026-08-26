// S6 — blocked / failed / review / attention rows for the mobile Inbox segment.
// Parity with web/app/dashboard/cockpit/InboxSection.tsx attention rows (:161-174).

import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { InboxItem } from '../api'
import { inboxKindLabel, inboxKindTone } from '../inboxAttention'
import { font, space, theme } from '../theme'
import { Button, Card, Chip } from '../ui'

export default function AttentionQueue({
  items,
  onDismiss,
  onRetry,
}: {
  items: InboxItem[]
  onDismiss: (taskId: string) => void
  onRetry: (taskId: string) => void
}) {
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  if (items.length === 0) return null

  const retry = (taskId: string) => {
    setRetrying((s) => new Set(s).add(taskId))
    onRetry(taskId)
  }

  return (
    <View style={s.wrap}>
      <Text style={s.heading}>Needs attention · {items.length}</Text>
      {items.map((i) => {
        const tone = inboxKindTone(i.kind)
        const busy = retrying.has(i.taskId)
        return (
          <Card key={i.taskId} style={{ marginBottom: space.lg }}>
            <View style={s.head}>
              <Chip label={inboxKindLabel(i.kind)} tone={tone} glyph={tone === 'danger' ? '✕' : '•'} />
              <Text style={s.agent} numberOfLines={1}>
                {i.agentEmoji} {i.agentName}
              </Text>
            </View>
            <Text style={s.title}>{i.title}</Text>
            {i.error ? (
              <Text style={s.error} numberOfLines={2}>
                {i.error}
              </Text>
            ) : null}
            <View style={s.actions}>
              {i.retryable ? (
                <View style={s.actionBtn}>
                  <Button
                    title={busy ? 'Retrying…' : '↻ Retry'}
                    onPress={() => retry(i.taskId)}
                    tone="ok"
                    busy={busy}
                  />
                </View>
              ) : null}
              <View style={s.actionBtn}>
                <Button title="Dismiss" onPress={() => onDismiss(i.taskId)} tone="ghost" />
              </View>
            </View>
          </Card>
        )
      })}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { marginBottom: space.lg },
  heading: {
    color: theme.text,
    fontSize: font.base,
    fontWeight: '800',
    marginBottom: space.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginBottom: space.sm,
  },
  agent: { flex: 1, color: theme.textDim, fontSize: font.sm, textAlign: 'right' },
  title: { color: theme.text, fontSize: font.base, fontWeight: '700', lineHeight: 22 },
  error: {
    color: theme.vermillion,
    fontSize: font.sm,
    fontFamily: 'Menlo',
    marginTop: space.sm,
    lineHeight: 18,
  },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  actionBtn: { flex: 1 },
})
