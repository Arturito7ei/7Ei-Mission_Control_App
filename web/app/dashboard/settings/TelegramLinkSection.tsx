'use client'
// Settings → Telegram — mint the one-time bind code, show link status, unbind.
// Backend: GET /arturita, POST/DELETE /arturita/bind (owner-only, Clerk-scoped).
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel } from '../ui'
import { useOrgRole } from '../useOrgRole'
import type { Getter } from '../cockpit/shared'
import {
  formatBindExpiry,
  formatTelegramStartCommand,
  isBindCodeActive,
  maskTelegramChatId,
  type ArturitaBindingState,
  type MintedBindCode,
} from '@/lib/arturitaTelegram.logic'

type ArturitaResp = ArturitaBindingState & { agent?: { name?: string } | null }

export default function TelegramLinkSection({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const { isOwner } = useOrgRole(orgId, getToken)
  const [state, setState] = useState<ArturitaBindingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [minted, setMinted] = useState<MintedBindCode | null>(null)
  const [copied, setCopied] = useState<'code' | 'command' | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [webhookNote, setWebhookNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api<ArturitaResp>(`/api/orgs/${orgId}/arturita`, { token: await getToken() })
      setState({ bound: r.bound, telegramChatId: r.telegramChatId ?? null })
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load Telegram status')
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
    setBusy(true); setErr(null); setCopied(null)
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
    if (!window.confirm('Unlink Telegram from this organisation? The bot will stop routing messages here until you link again.')) return
    setBusy(true); setErr(null); setMinted(null); setCopied(null)
    try {
      await api(`/api/orgs/${orgId}/arturita/bind`, { token: await getToken(), method: 'DELETE' })
      await load()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not unlink')
    }
    setBusy(false)
  }

  const registerWebhook = async () => {
    setBusy(true); setErr(null); setWebhookNote(null)
    try {
      const r = await api<{ ok?: boolean; webhookUrl?: string; description?: string; error?: string }>(
        '/api/telegram/setup-webhook', { token: await getToken(), method: 'POST' },
      )
      setWebhookNote(r.ok
        ? `Webhook registered${r.webhookUrl ? ` → ${r.webhookUrl}` : ''}${r.description ? ` (${r.description})` : ''}`
        : r.error ?? 'Registration failed')
    } catch (e: any) {
      setErr(e?.message ?? 'Could not register webhook')
    }
    setBusy(false)
  }

  const checkWebhook = async () => {
    setBusy(true); setErr(null); setWebhookNote(null)
    try {
      const r = await api<Record<string, unknown>>('/api/telegram/webhook-info', { token: await getToken() })
      const url = typeof r.url === 'string' ? r.url : null
      const pending = typeof r.pending_update_count === 'number' ? r.pending_update_count : null
      setWebhookNote(
        r.error
          ? String(r.error)
          : url
            ? `Telegram webhook: ${url}${pending != null ? ` · pending updates: ${pending}` : ''}`
            : JSON.stringify(r),
      )
    } catch (e: any) {
      setErr(e?.message ?? 'Could not read webhook info')
    }
    setBusy(false)
  }

  const copy = async (which: 'code' | 'command', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      window.setTimeout(() => setCopied(c => (c === which ? null : c)), 2000)
    } catch {
      setErr('Copy failed — select the text manually.')
    }
  }

  const codeActive = minted ? isBindCodeActive(minted.expiresAt, tick) : false
  const startCmd = minted && codeActive ? formatTelegramStartCommand(minted.bindCode) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md, maxWidth: 720 }}>
      <SectionLabel style={{ margin: 0 }}>Telegram</SectionLabel>
      <Card style={{ padding: space.lg, display: 'flex', flexDirection: 'column', gap: space.md }}>
        <p style={{ margin: 0, fontSize: text.sm.fontSize, color: tk.muted, lineHeight: 1.65 }}>
          Link your Telegram chat to Arturita so plain messages route into Mission Control.
          Use a <strong>dedicated Mission Control bot</strong> — not <code>@Cursor7EI_bot</code> (that token runs the Cursor bridge in polling mode).
        </p>

        {loading && <p style={{ margin: 0, color: tk.muted, fontSize: text.sm.fontSize }}>Loading…</p>}

        {!loading && state && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap',
            padding: `${space.sm}px ${space.md}px`, borderRadius: 8,
            background: state.bound ? 'var(--ok-dim, rgba(34,197,94,0.12))' : 'var(--s2)',
            border: `1px solid ${state.bound ? 'var(--ok-line, rgba(34,197,94,0.35))' : 'var(--line)'}`,
          }}>
            <span style={{ fontSize: 20 }}>{state.bound ? '🎯' : '✈️'}</span>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontWeight: 700, fontSize: text.lg.fontSize }}>
                {state.bound ? 'Linked' : 'Not linked'}
              </div>
              <div style={{ fontSize: text.sm.fontSize, color: tk.muted }}>
                {state.bound
                  ? `Chat ${maskTelegramChatId(state.telegramChatId)} · messages go to Arturita`
                  : 'Generate a bind code, then send it to your bot in Telegram'}
              </div>
            </div>
            {state.bound && isOwner && (
              <Button variant="default" disabled={busy} onClick={unbind}>Unlink</Button>
            )}
          </div>
        )}

        {isOwner === false && (
          <p style={{ margin: 0, fontSize: text.sm.fontSize, color: tk.muted }}>
            Only organisation owners can mint bind codes or unlink Telegram.
          </p>
        )}

        {isOwner && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
            <span style={{ fontSize: text.sm.fontSize, fontWeight: 600 }}>Backend webhook (owner)</span>
            <p style={{ margin: 0, fontSize: text.sm.fontSize, color: tk.muted, lineHeight: 1.6 }}>
              Fly must have <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_WEBHOOK_SECRET</code> set first.
              Then register the webhook here — no curl needed.
            </p>
            <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
              <Button variant="default" disabled={busy} onClick={registerWebhook}>Register webhook</Button>
              <Button variant="default" disabled={busy} onClick={checkWebhook}>Check webhook status</Button>
            </div>
            {webhookNote && (
              <p style={{ margin: 0, fontSize: text.sm.fontSize, color: tk.muted }}>{webhookNote}</p>
            )}
          </div>
        )}

        {isOwner && !state?.bound && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
            <Button variant="primary" disabled={busy} onClick={mintCode} style={{ width: 'fit-content' }}>
              {busy ? 'Working…' : minted && codeActive ? 'Generate new code' : 'Generate bind code'}
            </Button>

            {minted && (
              <div style={{
                padding: space.md, borderRadius: 10, background: 'var(--s0)',
                border: `1px solid ${codeActive ? 'var(--accent-line)' : 'var(--line)'}`,
              }}>
                <div style={{ fontSize: text.sm.fontSize, color: tk.muted, marginBottom: space.xs }}>
                  {codeActive ? formatBindExpiry(minted.expiresAt, tick) : formatBindExpiry(minted.expiresAt, tick)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                  <code style={{
                    fontSize: 22, fontWeight: 800, letterSpacing: 2,
                    padding: `${space.xs}px ${space.sm}px`, borderRadius: 8, background: 'var(--s2)',
                  }}>
                    {minted.bindCode}
                  </code>
                  {codeActive && (
                    <Button variant="default" onClick={() => copy('code', minted.bindCode)}>
                      {copied === 'code' ? 'Copied' : 'Copy code'}
                    </Button>
                  )}
                </div>
                {startCmd && (
                  <>
                    <p style={{ margin: `${space.md}px 0 ${space.xs}px`, fontSize: text.sm.fontSize, color: tk.muted }}>
                      In Telegram, open your Mission Control bot and send:
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                      <code style={{ fontSize: text.lg.fontSize, padding: `${space.xs}px ${space.sm}px`, background: 'var(--s2)', borderRadius: 8 }}>
                        {startCmd}
                      </code>
                      <Button variant="default" onClick={() => copy('command', startCmd)}>
                        {copied === 'command' ? 'Copied' : 'Copy command'}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            <ol style={{ margin: 0, paddingLeft: 20, fontSize: text.sm.fontSize, color: tk.muted, lineHeight: 1.7 }}>
              <li>Create a bot in BotFather if you do not have one yet (not <code>@Cursor7EI_bot</code>).</li>
              <li>Set Fly secrets, then use <strong>Register webhook</strong> above.</li>
              <li>Send <code>/start YOUR-CODE</code> in Telegram within 10 minutes — codes are single-use.</li>
              <li>After linking, plain text in that chat routes to Arturita.</li>
            </ol>
          </div>
        )}

        {err && <p style={{ margin: 0, fontSize: text.sm.fontSize, color: 'var(--danger-text)' }}>{err}</p>}
      </Card>
    </div>
  )
}
