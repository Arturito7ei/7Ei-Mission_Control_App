// MOB-6a — the screen every not-yet-built destination lands on.
//
// The point of this screen is that navigation is COMPLETE today: every row in
// More goes somewhere, nothing dead-ends, nothing crashes. Stages 6b+ replace
// these one at a time by flipping `status` in navModel.ts.
//
// It says WHY a surface is empty rather than a flat "coming soon", because the
// two reasons are not the same promise:
//   • 'planned' — the web has it, the phone will; the story is named.
//   • 'gap'     — nothing has it, on any client. Waiting won't help.
// Colorblind-safe throughout: each state carries a label + glyph, never hue alone.

import React from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import type { NavItem } from '../navModel'
import { PARITY_DOC } from '../navModel'
import { font, space, theme } from '../theme'
import { Card, Chip } from '../ui'

export default function PlaceholderScreen({ item }: { item: NavItem }) {
  const planned = item.status === 'planned'

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card>
        <View style={s.row}>
          <Text style={s.title}>
            {item.glyph}  {item.label}
          </Text>
          <Chip
            label={planned ? 'PLANNED' : 'NOT BUILT'}
            tone={planned ? 'info' : 'neutral'}
            glyph={planned ? '•' : '○'}
          />
        </View>

        <Text style={s.blurb}>{item.blurb}</Text>

        <View style={s.note}>
          {planned ? (
            <>
              <Text style={s.noteText}>
                ℹ  This screen isn't built on the phone yet. The data is already
                reachable from here — it's the same backend the web talks to.
              </Text>
              {item.story ? (
                <Text style={[s.noteText, { marginTop: space.sm }]}>
                  ✦  {item.story} builds it. See {PARITY_DOC}.
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={s.noteText}>
              ○  This surface doesn't exist on the web either — there's nothing to
              port yet. It's tracked as a gap, not as missing mobile work.
            </Text>
          )}
        </View>

        {item.mobileOnly ? (
          <Text style={s.meta}>Phone-only — the web has no matching page.</Text>
        ) : null}
        {item.webHosted ? (
          <Text style={s.meta}>On the web this is a tab on the {item.webHosted} page.</Text>
        ) : null}
        {item.webHidden ? (
          <Text style={s.meta}>On the web this is off the sidebar — reachable via ⌘K.</Text>
        ) : null}
      </Card>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  title: { color: theme.text, fontSize: font.lg, fontWeight: '700', flexShrink: 1 },
  blurb: { color: theme.textDim, fontSize: font.base, marginTop: space.md, lineHeight: 21 },
  note: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.s3,
    backgroundColor: theme.s2,
  },
  noteText: { color: theme.textDim, fontSize: font.sm, lineHeight: 19 },
  meta: { color: theme.textFaint, fontSize: font.sm, marginTop: space.md },
})
