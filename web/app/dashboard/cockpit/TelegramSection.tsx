'use client'
// Settings → Telegram — Arturita remote control (bind, status, panic, webhook reachability).
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel } from '../ui'
import { sx, type Getter } from './shared'
import { useOrgRole } from '../useOrgRole'
import {
  TELEGRAM_BOT_COMMANDS,
  formatBindExpiry,
  formatTelegramStartCommand,
  isBindCodeActive,
  maskTelegramChatId,
  type ArturitaBindingState,
  type MintedBindCode,
} from '@/lib/arturitaTelegram.logic'

type ArturitaResp = ArturitaBindingState & { agent?: { name?: string } | null }
type WebhookInfo = {
  url?: string
  pending_update_count?: number
  last_error_message?: string
  error?: string
}

export default function TelegramSection({ orgId, getToken, onChanged }: {
  orgId: string; getToken: Getter; onChanged?: () => void
}) {
  const { isOwner } = useOrgRole(orgId, getToken)
  const [state, setState] = useState<ArturitaBindingState | null>(null)
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [minted, setMinted] = useState<MintedBindCode | null>(null)
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(() => Date.now())

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api<ArturitaResp>(`/api/orgs/${orgId}/arturita`, { token: await getToken() })
      setState({ bound: r.bound, telegramChatId: r.telegramChatId ?? null })
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load connection status')
    }
    try {
      const w = await api<WebhookInfo>('/api/telegram/webhook-info', { token: await getToken() })
      setWebhook(w)
    } catch {
      setWebhook(null)
    }
    setLoading(false)
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!minted || !isBindCodeActive(minted.expiresAt, tick)) return
    const id = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [minted, tick])

  const mintCode = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api<MintedBindCode>(`/api/orgs/${orgId}/arturita/bind`, {
        token: await getToken(), method: 'POST',
      })
      setMinted(r)
      setTick(Date.now())
    } catch (e: any) {
      setErr(e?.message ?? 'Could not generate bind code')
    }
    setBusy(false)
  }

  const unbind = async () => {
    if (!window.confirm('Unlink Telegram from this organisation? The bot stops routing messages here until you link again.')) return
    setBusy(true); setErr(null); setMinted(null)
    try {
      await api(`/api/orgs/${orgId}/arturita/bind`, { token: await getToken(), method: 'DELETE' })
      await load()
      onChanged?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not unlink')
    }
    setBusy(false)
  }

  const panic = async () => {
    if (!window.confirm('Panic kills Arturita for this org: pauses the persona and revokes all command sessions. Continue?')) return
    setBusy(true); setErr(null)
    try {
      const sess = await api<{ token: string }>(`/api/orgs/${orgId}/arturita/session`, {
        token: await getToken(), method: 'POST', body: JSON.stringify({ source: 'desk' }),
      })
      await api(`/api/orgs/${orgId}/arturita/panic`, {
        method: 'POST',
        headers: { 'x-arturita-session': sess.token },
      })
      setMinted(null)
      await load()
      onChanged?.()
    } catch (e: any) {
      setErr(e?.message ?? 'Panic failed')
    }
    setBusy(false)
  }

  const copyStart = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setErr('Copy failed — select the command manually.')
    }
  }

  const codeActive = minted ? isBindCodeActive(minted.expiresAt, tick) : false
  const startCmd = minted && codeActive ? formatTelegramStartCommand(minted.bindCode) : null

  return (
    <div>
      <div style={sx.sectionHead}>
        <SectionLabel style={{ margin: 0 }}>Telegram</SectionLabel>
        <Button style={{ color: tk.accent }} disabled={busy} onClick={load}>↻ Refresh</Button>
      </div>

      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.lg, padding: space.lg }}>
        <p style={{ ...sx.hint, margin: 0 }}>
          Link your Telegram chat to Arturita. Use a dedicated Mission Control bot — not{' '}
          <code>@Cursor7EI_bot</code> (Cursor bridge, polling mode).
        </p>

        {loading && <p style={{ ...sx.empty, margin: 0 }}>Loading…</p>}

        {!loading && state && (
          <div style={{
            padding: space.md, borderRadius: tk.r.md,
            background: state.bound ? 'var(--ok-bg)' : 'var(--s2)',
            border: `1px solid ${state.bound ? 'var(--ok)' : 'var(--line)'}`,
          }}>
            <div style={{ fontWeight: 700, fontSize: text.lg.fontSize }}>
              {state.bound ? 'Linked' : 'Not linked'}
            </div>
            <div style={{ fontSize: text.sm.fontSize, color: tk.muted, marginTop: space.xs }}>
              {state.bound
                ? `Chat ${maskTelegramChatId(state.telegramChatId)} · plain text routes to Arturita`
                : 'Mint a bind code, then send /start CODE in Telegram (10 min, single-use).'}
            </div>
          </div>
        )}

        {webhook && (
          <div>
            <div style={{ fontWeight: 600, fontSize: text.md.fontSize, marginBottom: space.xs }}>Webhook reachability</div>
            {webhook.error ? (
              <p style={{ ...sx.hint, margin: 0, color: 'var(--warn)' }}>{webhook.error}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: text.sm.fontSize, color: tk.muted, lineHeight: 1.7 }}>
                <li>{webhook.url ? `Registered: ${webhook.url}` : 'No webhook URL registered yet'}</li>
                {webhook.pending_update_count != null && (
                  <li>Pending updates: {webhook.pending_update_count}</li>
                )}
                {webhook.last_error_message && (
                  <li style={{ color: 'var(--danger-text)' }}>Last error: {webhook.last_error_message}</li>
                )}
              </ul>
            )}
            <p style={{ ...sx.hint, margin: `${space.sm}px 0 0` }}>
              Read-only. Webhook registration stays a Fly/CLI step — not exposed in this UI.
            </p>
          </div>
        )}

        {isOwner === false && (
          <p style={{ ...sx.hint, margin: 0 }}>Only organisation owners can link, unlink, or panic.</p>
        )}

        {isOwner && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm }}>
            <Button variant="primary" disabled={busy} onClick={mintCode}>
              {busy ? 'Working…' : minted && codeActive ? 'New bind code' : 'Generate bind code'}
            </Button>
            {state?.bound && (
              <Button variant="default" disabled={busy} onClick={unbind}>Unlink chat</Button>
            )}
            <Button variant="danger" disabled={busy} onClick={panic} title="Pause Arturita and revoke all command sessions">
              Panic / kill switch
            </Button>
          </div>
        )}

        {minted && (
          <div style={{ padding: space.md, background: 'var(--s0)', borderRadius: tk.r.md, border: '1px solid var(--line)' }}>
            <div style={{ fontSize: text.sm.fontSize, color: tk.muted }}>{formatBindExpiry(minted.expiresAt, tick)}</div>
            <code style={{
              display: 'block', marginTop: space.sm, fontSize: 22, fontWeight: 800, letterSpacing: 2,
            }}>
              {minted.bindCode}
            </code>
            {startCmd && (
              <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
                <code style={{ fontSize: text.md.fontSize }}>{startCmd}</code>
                <Button variant="default" onClick={() => copyStart(startCmd)}>
                  {copied ? 'Copied' : 'Copy command'}
                </Button>
              </div>
            )}
          </div>
        )}

        <div>
          <div style={{ fontWeight: 600, fontSize: text.md.fontSize, marginBottom: space.sm }}>Bot commands</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
            {TELEGRAM_BOT_COMMANDS.map(c => (
              <div key={c.cmd} style={{ fontSize: text.sm.fontSize }}>
                <code>{c.cmd}</code>
                <span style={{ color: tk.muted }}> — {c.desc}</span>
              </div>
            ))}
            <div style={{ fontSize: text.sm.fontSize, color: tk.muted, marginTop: space.xs }}>
              Plain text in a linked chat also routes to Arturita (after #371 on backend).
            </div>
          </div>
        </div>

        {err && <div style={sx.err}>⚠ {err}</div>}
      </Card>
    </div>
  )
}
