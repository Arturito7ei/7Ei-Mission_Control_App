'use client'
// MCC-1 — Chat: talk to any agent, replies included, from the Inbox area.
//
// One surface, two runtimes, one contract:
//   • INTERNAL agents answer synchronously — the reply is in the POST response.
//   • EXTERNAL agents (OpenClaw / Cursor / Claude Code…) receive the message as
//     an assigned task their poll loop claims; their /result lands in the SAME
//     thread, so this panel just keeps polling the GET until it appears.
// The thread is server truth (`messages` table via the org-scoped chat routes);
// everything client-side is a cache merged by id (lib/chat.logic).
//
// Colorblind-safe (DESIGN_SYSTEM v2): the user/assistant sides are told apart by
// ALIGNMENT + label, never color alone; the awaiting-reply state is text + ⏳.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { mergeThread, awaitingReply, threadPreview, chatSendError, type ChatMsg } from '@/lib/chat.logic'
import { tk, text, space } from './tokens'
import { Button, Card, SectionLabel, TextArea } from './ui'

type Getter = () => Promise<string | null>
export interface ChatAgent { id: string; name: string; avatarEmoji?: string | null; status?: string; runtime?: string }

const POLL_MS = 4000

export default function ChatPanel({ orgId, getToken, agents }: { orgId: string; getToken: Getter; agents: ChatAgent[] }) {
  const [sel, setSel] = useState<string | null>(agents[0]?.id ?? null)
  const [threads, setThreads] = useState<Record<string, ChatMsg[]>>({})
  const [meta, setMeta] = useState<Record<string, { external: boolean }>>({})
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // If the roster arrives after mount, select the first agent once.
  useEffect(() => { if (!sel && agents.length) setSel(agents[0].id) }, [agents, sel])

  const load = useCallback(async (agentId: string) => {
    try {
      const token = await getToken()
      const r = await api<{ messages: ChatMsg[]; agent: { external: boolean } }>(
        `/api/orgs/${orgId}/agents/${agentId}/chat`, { token })
      setThreads(t => ({ ...t, [agentId]: mergeThread(t[agentId] ?? [], r.messages) }))
      setMeta(m => ({ ...m, [agentId]: { external: r.agent.external } }))
      setErr(null)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load the thread.') }
  }, [orgId, getToken])

  // Poll the SELECTED thread — replies from external runtimes arrive out-of-band.
  useEffect(() => {
    if (!sel) return
    load(sel)
    const t = setInterval(() => load(sel), POLL_MS)
    return () => clearInterval(t)
  }, [sel, load])

  // Keep the newest message on screen unless the operator scrolled up to read.
  const msgs = sel ? threads[sel] ?? [] : []
  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [msgs.length, sel])

  const send = useCallback(async () => {
    if (!sel || sending) return
    const problem = chatSendError(input)
    if (problem) { setErr(problem); return }
    const content = input.trim()
    setSending(true); setErr(null)
    try {
      const token = await getToken()
      const r = await api<{ message: ChatMsg; reply?: ChatMsg }>(
        `/api/orgs/${orgId}/agents/${sel}/chat`,
        { token, method: 'POST', body: JSON.stringify({ content }) })
      setInput('')
      stickToBottom.current = true
      setThreads(t => ({ ...t, [sel]: mergeThread(t[sel] ?? [], [r.message, ...(r.reply ? [r.reply] : [])]) }))
    } catch (e: any) { setErr(e?.message ?? 'Send failed.') }
    finally { setSending(false) }
  }, [sel, sending, input, orgId, getToken])

  const selAgent = agents.find(a => a.id === sel) ?? null
  const waiting = awaitingReply(msgs) && (meta[sel ?? '']?.external ?? false)

  return (
    <div style={{ display: 'flex', gap: space.xl, alignItems: 'stretch', height: 'calc(100vh - 160px)', minHeight: 360 }}>
      {/* ── Agent thread list ── */}
      <Card style={{ width: 240, flexShrink: 0, overflowY: 'auto', padding: space.md }}>
        <SectionLabel>Chat</SectionLabel>
        {agents.length === 0 && <div style={{ ...text.sm, color: tk.muted, padding: space.md }}>No agents yet — add one from the Agents page.</div>}
        {agents.map(a => (
          <button key={a.id} onClick={() => { stickToBottom.current = true; setSel(a.id) }}
            aria-current={sel === a.id ? 'true' : undefined}
            style={{
              display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
              background: sel === a.id ? 'var(--accent-dim)' : 'transparent',
              border: '1px solid ' + (sel === a.id ? 'var(--accent)' : 'transparent'),
              borderRadius: 8, padding: `${space.sm}px ${space.md}px`, marginBottom: space.xs,
            }}>
            <div style={{ ...text.md, fontWeight: 600, color: tk.text }}>
              {a.avatarEmoji ? `${a.avatarEmoji} ` : ''}{a.name}
            </div>
            <div style={{ ...text.sm, color: tk.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {threadPreview(threads[a.id] ?? []) || (a.runtime && a.runtime !== 'internal' ? a.runtime : 'no messages yet')}
            </div>
          </button>
        ))}
      </Card>

      {/* ── Thread + composer ── */}
      <Card style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: space.md, minWidth: 0 }}>
        {!selAgent ? (
          <div style={{ ...text.md, color: tk.muted, margin: 'auto' }}>Select an agent to start a conversation.</div>
        ) : (
          <>
            <div style={{ ...text.md, fontWeight: 700, padding: `${space.xs}px ${space.sm}px`, borderBottom: '1px solid var(--line)' }}>
              {selAgent.avatarEmoji ? `${selAgent.avatarEmoji} ` : ''}{selAgent.name}
              {meta[selAgent.id]?.external && <span style={{ ...text.sm, color: tk.muted, marginLeft: space.md }}>external runtime — replies arrive via its poll loop</span>}
            </div>

            <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: space.md }}
              onScroll={e => {
                const el = e.currentTarget
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}>
              {msgs.length === 0 && <div style={{ ...text.sm, color: tk.muted }}>No messages yet — say hello.</div>}
              {msgs.map(m => {
                const mine = m.role === 'user'
                return (
                  <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: space.sm }}>
                    <div style={{
                      maxWidth: '72%', borderRadius: 10, padding: `${space.sm}px ${space.lg}px`,
                      background: mine ? 'var(--accent-dim)' : 'var(--s1)',
                      border: '1px solid ' + (mine ? 'var(--accent)' : 'var(--line)'),
                    }}>
                      <div style={{ ...text.sm, color: tk.muted, marginBottom: 2 }}>
                        {mine ? 'You' : selAgent.name} · {new Date(m.createdAt as any).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div style={{ ...text.md, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.content}</div>
                    </div>
                  </div>
                )
              })}
              {waiting && <div style={{ ...text.sm, color: tk.muted, padding: space.sm }}>⏳ Delivered — awaiting {selAgent.name}&apos;s reply…</div>}
            </div>

            {err && <div role="alert" style={{ ...text.sm, color: 'var(--danger)', padding: `0 ${space.sm}px ${space.xs}px` }}>{err}</div>}

            <div style={{ display: 'flex', gap: space.md, alignItems: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: space.md }}>
              <TextArea value={input} onChange={e => setInput(e.target.value)} rows={2}
                placeholder={`Message ${selAgent.name} — Enter to send, Shift+Enter for a new line`}
                aria-label={`Message ${selAgent.name}`}
                style={{ flex: 1, resize: 'vertical' }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                }} />
              <Button variant="primary" onClick={send} disabled={sending || !input.trim()}>
                {sending ? 'Sending…' : '➤ Send'}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
