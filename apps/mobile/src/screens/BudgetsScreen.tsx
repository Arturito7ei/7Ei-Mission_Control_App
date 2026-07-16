// MOB-6d — Budgets. Read-only, replacing the `budgets` placeholder.
//
// MIRRORS the web's Budgets section (web/app/dashboard/cockpit/BudgetsSection.tsx,
// a hosted tab under Costs) over the same call:
//
//   GET /api/orgs/:orgId/budgets → each policy with the server's own verdict
//                                  (`spend`, `state`, `pct`) already attached
//
// The backend evaluates every policy itself (`evaluatePolicy`), so both clients
// render one verdict rather than each computing its own — a phone that decided
// "breach" a percentage point earlier than the desk would be its own bug.
//
// READ-ONLY, deliberately: the web's section also creates a policy (＋ Budget)
// and deletes one. Setting a hard-stop that can halt the org's spending is a
// desk decision — it wants the dialog, the scope picker and the second look that
// a 390pt screen makes worse, not better. The phone answers "am I near the cap?",
// which is the question you have when you're away from the desk. MOB-6d ships the
// read; changing a cap stays where it is.
//
// The web colours each row red/accent/green by state. The operator is red-green
// colorblind, so state travels as a label + glyph here and the tone is decoration
// on top (costs.ts `budgetChip` owns that mapping — `state` is its own
// vocabulary and must not be fed to status.ts, which would collapse all three
// onto 'idle' and make a BREACH look healthy).

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Api } from '../api'
import { useAuth } from '../auth'
import { budgetAmountLabel, budgetChip, budgetScopeLabel, type BudgetLite } from '../costs'
import { font, space, theme } from '../theme'
import { Banner, Card, Chip, Empty, Loading } from '../ui'

export default function BudgetsScreen() {
  const { apiUrl, getToken, orgId } = useAuth()
  const [budgets, setBudgets] = useState<BudgetLite[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    try {
      setBudgets(await Api.budgets(apiUrl, token, orgId))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load budgets.')
      setBudgets([])
    }
  }, [apiUrl, getToken, orgId])

  useEffect(() => {
    load()
  }, [load])

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl refreshing={budgets === null} onRefresh={load} tintColor={theme.blue} />
      }
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {budgets === null ? (
        <Loading text="Loading budgets…" />
      ) : budgets.length === 0 ? (
        // The web's empty copy, minus its call to action: adding a cap is a desk
        // move, so promising it here would be an affordance that isn't there.
        <Empty text="No budgets — a hard-stop can cap spend by company, agent, project, or goal. Add one from the desk." />
      ) : (
        budgets.map((b) => {
          const chip = budgetChip(b.state)
          return (
            <Card key={b.id} style={{ marginBottom: space.md }}>
              <View style={s.head}>
                <Text style={s.scope} numberOfLines={1}>
                  {budgetScopeLabel(b)}
                </Text>
                <Chip label={(b.state || 'unknown').toUpperCase()} tone={chip.tone} glyph={chip.glyph} />
              </View>
              <View style={s.foot}>
                <Text style={s.amount}>{budgetAmountLabel(b)}</Text>
                {/* `pct` is a FRACTION on the wire (0–1), not a percentage —
                    the web multiplies by 100 to draw its bar, so we do the same
                    to print it. Reading it as 0–100 would render 24% as "0%". */}
                <Text style={s.pct}>{Math.round(b.pct * 100)}% of cap</Text>
              </View>
            </Card>
          )
        })
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  scope: { color: theme.text, fontSize: font.base, fontWeight: '700', flex: 1, textTransform: 'capitalize' },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.md },
  amount: { color: theme.blue, fontSize: font.base, fontWeight: '700' },
  pct: { color: theme.textDim, fontSize: font.sm },
})
