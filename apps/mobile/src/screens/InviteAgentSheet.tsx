// AAD-2 (mobile) — the "+ Agent" invite-onboarding sheet. The phone's mirror of
// the desk's `web/app/dashboard/cockpit/InviteAgentDialog.tsx`: same endpoints,
// same field names, same limits, same one-time reveal, same honest posture
// banner. The decisions live in the pure `invites.ts` (pinned against the web's
// module by invites.test.ts); this file is the rendering.
//
// THREE INVARIANTS ARE VISIBLE HERE, and each one is load-bearing:
//
//  * The runtime picker RENDERS FROM the server registry (`GET /api/adapters`),
//    never from a list on the device. Runtimes MC cannot dispatch to are shown
//    as "not yet available" and are NOT selectable — inviting one would create
//    an invite that can never be spent.
//  * The RAW invite token is shown ONCE and is never written to storage. There
//    is no agent key here at all: the key is minted when the agent claims the
//    invite, and only the claimer sees it.
//  * `joinEnabled === false` (hosted: MC_ENABLE_REMOTE_ONBOARDING unset) is
//    stated plainly. Softening it to make the new entry point feel finished
//    would be the exact dishonesty the ONB epic was built to avoid.
//
// COPY-OUT. No clipboard dependency is added: RN's built-in `Share` sheet hands
// the prompt to any app (Notes, Messages, a terminal), and the token itself is
// rendered `selectable` for a long-press copy.

import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Api, type AgentInvite, type CreateInviteResult } from '../api'
import { useAuth } from '../auth'
import { isOwnerRole } from '../agentEdit'
import {
  CREATE_INVITE_DEFAULTS,
  INVITE_MAX_TTL_HOURS,
  INVITE_MAX_USES,
  INVITE_POSTURE_NOTE,
  JOIN_CLOSED_NOTE,
  ONE_TIME_REVEAL_NOTE,
  buildCreateInviteBody,
  inviteStatusChip,
  pickableAdapters,
  toggleAdapterType,
  unavailableAdapters,
  validateCreateInvite,
  type AdapterRegistryEntry,
  type CreateInviteForm,
} from '../invites'
import { font, radius, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Loading } from '../ui'

export default function InviteAgentSheet({
  apiUrl,
  getToken,
  orgId,
  onClose,
}: {
  apiUrl: string
  getToken: () => Promise<string | null>
  orgId: string
  onClose: () => void
}) {
  const [adapters, setAdapters] = useState<AdapterRegistryEntry[] | null>(null)
  const [joinEnabled, setJoinEnabled] = useState<boolean | null>(null)
  const [invites, setInvites] = useState<AgentInvite[]>([])
  const [form, setForm] = useState<CreateInviteForm>(CREATE_INVITE_DEFAULTS)
  const [created, setCreated] = useState<CreateInviteResult | null>(null)
  const [mode, setMode] = useState<'create' | 'list'>('create')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadInvites = useCallback(async () => {
    const token = await getToken()
    if (!token) return
    try {
      setInvites(await Api.agentInvites(apiUrl, token, orgId))
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load invites.')
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    ;(async () => {
      const token = await getToken()
      if (!token) {
        setErr('Not signed in.')
        setAdapters([])
        return
      }
      // The registry is what the picker needs; the posture is a nice-to-have that
      // must not blank the sheet if it 403s.
      const [reg, posture] = await Promise.allSettled([
        Api.adapters(apiUrl, token),
        Api.onboardingPosture(apiUrl, token, orgId),
      ])
      if (reg.status === 'fulfilled') setAdapters(reg.value)
      else {
        setAdapters([])
        setErr(reg.reason?.message ?? 'Could not load the adapter registry.')
      }
      if (posture.status === 'fulfilled') setJoinEnabled(!!posture.value?.publicJoinEnabled)
      loadInvites()
    })()
  }, [apiUrl, getToken, orgId, loadInvites])

  const picks = pickableAdapters(adapters)
  const notYet = unavailableAdapters(adapters)

  const submit = async () => {
    const problems = validateCreateInvite(form)
    if (problems.length) {
      setErr(problems.join(' '))
      return
    }
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      setCreated(await Api.createAgentInvite(apiUrl, token, orgId, buildCreateInviteBody(form)))
      loadInvites()
    } catch (e: any) {
      // 403 = not an owner (the real enforcer), 400 = out-of-range uses/TTL
      // (refused, never clamped). Say which; the form is kept.
      setErr(e?.message ?? 'Could not create the invite.')
    }
    setBusy(false)
  }

  const revoke = async (id: string) => {
    const token = await getToken()
    if (!token) return
    const before = invites
    setInvites((x) => x.map((i) => (i.id === id ? { ...i, status: 'revoked' } : i)))
    try {
      await Api.revokeAgentInvite(apiUrl, token, orgId, id)
    } catch (e: any) {
      setInvites(before)
      setErr(e?.message ?? 'Could not revoke that invite.')
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.head}>
            <Text style={s.title}>{created ? '✓ Invite created' : 'Invite an agent'}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
              <Text style={s.close}>✕</Text>
            </Pressable>
          </View>

          {/* KEYBOARD. This is the app's only BOTTOM-ANCHORED sheet (the backdrop
              is `flex-end`, so the sheet does not move when the keyboard opens) and
              it has three inputs low in the scroll — Max uses, Time to live, and the
              multiline Message — with the "Create invite + prompt" button directly
              beneath them. Without this the keyboard covers that whole band and the
              submit button is simply unreachable: the ScrollView's frame still
              extends under the keyboard, so there is no scroll offset that brings
              the button into view.

              `automaticallyAdjustKeyboardInsets` makes iOS add the keyboard/scroll
              -view overlap as a bottom content inset, which both raises the maximum
              scroll offset (every field AND the button can be scrolled clear of the
              keyboard) and scrolls the focused input into the remaining visible
              region. The app's other two keyboard surfaces (ConnectScreen,
              CommandCenterScreen) use KeyboardAvoidingView instead — correct for a
              full-screen `flex: 1` shell, but wrong here: `behavior="padding"` on a
              height-capped sheet inside a Modal fights the `maxHeight: '92%'`
              rather than the keyboard.

              `keyboardShouldPersistTaps="handled"` is the other half and is load
              -bearing, not decoration: with the keyboard up, it lets the tap on
              "Create invite + prompt" reach onPress on the FIRST tap instead of
              being consumed dismissing the keyboard. */}
          <ScrollView
            contentContainerStyle={{ padding: space.lg, gap: space.md }}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            {err ? <Banner kind="error">{err}</Banner> : null}

            {created ? (
              <Reveal
                created={created}
                onDone={() => {
                  setCreated(null)
                  setForm(CREATE_INVITE_DEFAULTS)
                  setMode('list')
                }}
              />
            ) : (
              <>
                <View style={s.tabs}>
                  {(['create', 'list'] as const).map((m) => (
                    <Pressable
                      key={m}
                      accessibilityRole="button"
                      accessibilityState={{ selected: mode === m }}
                      onPress={() => setMode(m)}
                      style={[s.tab, mode === m && s.tabOn]}
                    >
                      <Text style={[s.tabText, mode === m && s.tabTextOn]}>
                        {m === 'create' ? 'New invite' : `Active invites${invites.length ? ` · ${invites.filter((i) => i.status === 'active').length}` : ''}`}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {mode === 'create' ? (
                  <>
                    <Text style={s.hint}>{INVITE_POSTURE_NOTE}</Text>

                    <Card style={{ gap: space.md }}>
                      <Text style={s.cardTitle}>Allowed runtime(s)</Text>
                      <Text style={s.cardHint}>From the server adapter registry — not a list on this device.</Text>
                      {adapters === null ? (
                        <Loading text="Loading adapters…" />
                      ) : picks.length === 0 ? (
                        <Text style={s.empty}>No invitable runtimes available.</Text>
                      ) : (
                        <View style={s.chipWrap}>
                          {picks.map((a) => {
                            const on = form.adapterTypes.includes(a.type)
                            return (
                              <Pressable
                                key={a.type}
                                accessibilityRole="button"
                                accessibilityState={{ selected: on }}
                                onPress={() => setForm((f) => ({ ...f, adapterTypes: toggleAdapterType(f.adapterTypes, a.type) }))}
                                style={[s.pick, on && s.pickOn]}
                              >
                                <Text style={[s.pickText, on && s.pickTextOn]}>
                                  {on ? '✓ ' : ''}
                                  {a.label}
                                </Text>
                              </Pressable>
                            )
                          })}
                        </View>
                      )}
                      <Text style={s.cardHint}>
                        {form.adapterTypes.length === 0
                          ? 'None selected → any invitable runtime may join.'
                          : `${form.adapterTypes.length} selected.`}
                      </Text>

                      {notYet.length > 0 ? (
                        <View style={{ gap: space.xs }}>
                          <Text style={s.fieldLabel}>Not yet available</Text>
                          <View style={s.chipWrap}>
                            {notYet.map((a) => (
                              <View key={a.type} style={s.pickOff} accessibilityState={{ disabled: true }}>
                                <Text style={s.pickOffText}>○ {a.label}</Text>
                              </View>
                            ))}
                          </View>
                          <Text style={s.cardHint}>
                            Declared in the adapter registry, but Mission Control cannot hand these runtimes work yet — so they
                            cannot be invited.
                          </Text>
                        </View>
                      ) : null}
                    </Card>

                    <Card style={{ gap: space.md }}>
                      <Text style={s.cardTitle}>Uses & expiry</Text>
                      <View style={s.row}>
                        <Text style={[s.fieldLabel, { flex: 1 }]}>Multi-use invite</Text>
                        <Switch
                          value={form.multiUse}
                          onValueChange={(v) => setForm((f) => ({ ...f, multiUse: v }))}
                          trackColor={{ true: theme.blue, false: theme.s3 }}
                        />
                      </View>
                      <Text style={s.cardHint}>
                        {form.multiUse ? `Up to ${INVITE_MAX_USES} uses.` : 'Single-use — the default, and the safer one.'}
                      </Text>
                      {form.multiUse ? (
                        <NumberField
                          label="Max uses"
                          value={form.uses}
                          onChange={(n) => setForm((f) => ({ ...f, uses: n }))}
                        />
                      ) : null}
                      <NumberField
                        label={`Time to live (hours) — max ${INVITE_MAX_TTL_HOURS}`}
                        value={form.ttlHours}
                        onChange={(n) => setForm((f) => ({ ...f, ttlHours: n }))}
                      />
                      <View style={{ gap: space.xs }}>
                        <Text style={s.fieldLabel}>Message (optional) — context for the agent, not an instruction</Text>
                        <TextInput
                          value={form.message}
                          onChangeText={(t) => setForm((f) => ({ ...f, message: t }))}
                          multiline
                          placeholderTextColor={theme.textFaint}
                          style={[s.input, { minHeight: 64, textAlignVertical: 'top' }]}
                        />
                      </View>
                    </Card>

                    {joinEnabled === false ? <Banner kind="info">{JOIN_CLOSED_NOTE}</Banner> : null}

                    <Button title="Create invite + prompt" tone="primary" busy={busy} disabled={busy} onPress={submit} />
                  </>
                ) : (
                  <Card style={{ gap: space.sm }}>
                    {invites.length === 0 ? (
                      <Text style={s.empty}>No invites yet.</Text>
                    ) : (
                      invites.map((i) => {
                        const chip = inviteStatusChip(i.status)
                        return (
                          <View key={i.id} style={s.inviteRow}>
                            <Chip label={chip.label} glyph={chip.icon} tone={chip.tone === 'ok' ? 'ok' : chip.tone === 'fail' ? 'danger' : 'neutral'} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={s.inviteAllow} numberOfLines={1}>
                                {i.allowedAdapterTypes ? i.allowedAdapterTypes.join(', ') : 'any runtime'}
                              </Text>
                              <Text style={s.inviteMeta}>
                                {i.usesRemaining}/{i.maxUses} uses left · expires {new Date(i.expiresAt).toLocaleString()}
                              </Text>
                            </View>
                            {i.status === 'active' ? (
                              <Pressable onPress={() => revoke(i.id)} accessibilityRole="button" hitSlop={8}>
                                <Text style={s.revoke}>✕ Revoke</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        )
                      })
                    )}
                  </Card>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

// ─── The "+ Agent" entry point ────────────────────────────────────────────────

/**
 * The button + its sheet, so a surface that wants the entry point gets it in one
 * line and both surfaces gate it identically. Mounted on the Agents roster and
 * on the Org chart — the two places an operator looks for "add someone", and the
 * two the desk was also missing until AAD-2.
 *
 * GATING. `POST …/agent-invites` is `requireOrgRole('owner')`, so a member would
 * only ever collect a 403 — hidden. An UNKNOWN role (a pasted token whose orgs
 * were never listed with a role) still gets the affordance, with the caution the
 * phone already uses for its owner-gated edits: the backend is the real enforcer,
 * and locking a legitimate owner out of the device on a *maybe* is worse than a
 * named 403.
 */
export function AddAgentButton({ compact }: { compact?: boolean }) {
  const { apiUrl, getToken, orgId, orgRole } = useAuth()
  const [open, setOpen] = useState(false)
  const owner = isOwnerRole(orgRole)
  const roleUnknown = orgRole == null
  if (!orgId || (!owner && !roleUnknown)) return null
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Add an agent — create an invite and onboarding prompt"
        style={({ pressed }) => [s.addBtn, compact && s.addBtnCompact, pressed && { opacity: 0.7 }]}
      >
        <Text style={s.addBtnText}>＋ Agent</Text>
      </Pressable>
      {open ? (
        <InviteAgentSheet apiUrl={apiUrl} getToken={getToken} orgId={orgId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

// ─── The one-time reveal ──────────────────────────────────────────────────────

function Reveal({ created, onDone }: { created: CreateInviteResult; onDone: () => void }) {
  return (
    <View style={{ gap: space.md }}>
      <Text style={s.hint}>{ONE_TIME_REVEAL_NOTE}</Text>

      {created.joinEnabled === false ? <Banner kind="info">{JOIN_CLOSED_NOTE}</Banner> : null}

      <Card style={{ gap: space.sm }}>
        <Text style={s.fieldLabel}>Invite token (shown once)</Text>
        <Text selectable style={s.token}>
          {created.inviteToken}
        </Text>
        <Button
          title="Share token"
          tone="ghost"
          onPress={() => Share.share({ message: created.inviteToken })}
        />
      </Card>

      <Card style={{ gap: space.sm }}>
        <Text style={s.fieldLabel}>Onboarding prompt — paste into any agent’s chat</Text>
        <ScrollView style={{ maxHeight: 220 }}>
          <Text selectable style={s.prompt}>
            {created.onboardingPrompt}
          </Text>
        </ScrollView>
        <Button
          title="Share onboarding prompt"
          tone="primary"
          onPress={() => Share.share({ message: created.onboardingPrompt })}
        />
        <Button
          title="Share doc URL"
          tone="ghost"
          onPress={() => Share.share({ message: created.onboardingTextUrl })}
        />
      </Card>

      <Button title="Done" tone="ghost" onPress={onDone} />
    </View>
  )
}

// ─── primitives ───────────────────────────────────────────────────────────────

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        value={String(value)}
        onChangeText={(t) => onChange(Number(t.replace(/[^0-9]/g, '')) || 0)}
        keyboardType="number-pad"
        placeholderTextColor={theme.textFaint}
        style={s.input}
      />
    </View>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '92%' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.s3,
  },
  title: { color: theme.text, fontSize: font.lg, fontWeight: '800' },
  close: { color: theme.textDim, fontSize: font.lg, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: space.sm },
  tab: { paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: theme.s3 },
  tabOn: { borderColor: theme.blue, backgroundColor: theme.s2 },
  tabText: { color: theme.textDim, fontSize: font.sm, fontWeight: '700' },
  tabTextOn: { color: theme.text },
  hint: { color: theme.textDim, fontSize: font.sm, lineHeight: 19 },
  cardTitle: { color: theme.text, fontSize: font.base, fontWeight: '800' },
  cardHint: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 17 },
  fieldLabel: { color: theme.textDim, fontSize: font.sm - 1, fontWeight: '600' },
  empty: { color: theme.textDim, fontSize: font.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pick: { paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: theme.s3 },
  pickOn: { borderColor: theme.blue, backgroundColor: theme.s2 },
  pickText: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  pickTextOn: { color: theme.text },
  pickOff: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.s3,
    opacity: 0.7,
  },
  pickOffText: { color: theme.textFaint, fontSize: font.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  input: {
    backgroundColor: theme.s2,
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.md,
    color: theme.text,
    fontSize: font.base,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  token: {
    color: theme.text,
    fontFamily: 'Courier',
    fontSize: font.sm,
    backgroundColor: theme.s2,
    borderRadius: radius.md,
    padding: space.md,
  },
  prompt: { color: theme.text, fontSize: font.sm - 1, lineHeight: 18, fontFamily: 'Courier' },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  inviteAllow: { color: theme.text, fontSize: font.sm, fontWeight: '600' },
  inviteMeta: { color: theme.textFaint, fontSize: font.sm - 2, marginTop: 2 },
  revoke: { color: theme.vermillion, fontSize: font.sm, fontWeight: '700' },
  addBtn: {
    borderWidth: 1,
    borderColor: theme.blue,
    backgroundColor: theme.s2,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    alignSelf: 'flex-start',
    // The button owns its own spacing so the CALLER needs no wrapper View. A
    // wrapper keeps laying out its margin after this component returns null for a
    // non-owner — a stray ~16pt gap where a button they never see would have been.
    marginBottom: space.md,
  },
  addBtnCompact: { paddingVertical: space.xs },
  addBtnText: { color: theme.blue, fontSize: font.sm, fontWeight: '800' },
})
