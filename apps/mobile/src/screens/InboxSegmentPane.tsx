// S6 — mobile Inbox segment: attention queue + approvals (MOB-4 gate untouched).
//
// Loads GET /api/orgs/:orgId/inbox for the attention rows the desk shows in
// InboxSection, then hosts ApprovalsPane below with the same step-up path as before.

import React, { useCallback, useEffect, useState } from 'react'
import { Api, type InboxItem } from '../api'
import { useAuth } from '../auth'
import AttentionQueue from './AttentionQueue'
import ApprovalsPane from './ApprovalsPane'

export default function InboxSegmentPane() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [attentionTick, setAttentionTick] = useState(0)

  const loadAttention = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    try {
      const r = await Api.inbox(apiUrl, token, orgId)
      setItems(r.items ?? [])
    } catch {
      setItems([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    loadAttention()
  }, [loadAttention, attentionTick])

  const dismiss = useCallback(
    async (taskId: string) => {
      const token = await getToken()
      if (!token || !orgId) return
      setItems((cur) => (cur ?? []).filter((i) => i.taskId !== taskId))
      try {
        await Api.dismissInboxItem(apiUrl, token, orgId, taskId)
      } catch {
        setAttentionTick((n) => n + 1)
      }
    },
    [apiUrl, getToken, orgId],
  )

  const retry = useCallback(
    async (taskId: string) => {
      const token = await getToken()
      if (!token) return
      setItems((cur) => (cur ?? []).filter((i) => i.taskId !== taskId))
      try {
        await Api.retryTask(apiUrl, token, taskId)
      } catch {
        /* reload below */
      }
      setAttentionTick((n) => n + 1)
    },
    [apiUrl, getToken],
  )

  const header =
    items === null ? null : (
      <AttentionQueue items={items} onDismiss={dismiss} onRetry={retry} />
    )

  return (
    <ApprovalsPane
      header={header}
      onRefreshExtra={loadAttention}
    />
  )
}
