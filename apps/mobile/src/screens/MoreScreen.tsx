// MOB-6a — the More screen: every Mission Control section the tab bar can't hold.
//
// Why a list screen and not a drawer: a drawer is a desktop metaphor that costs
// react-native-reanimated + react-native-gesture-handler, and it hides the very
// thing we're trying to make discoverable. A pushed list is one tap in, one swipe
// back, scrolls to any length, and reads correctly under VoiceOver for free.
//
// Rendered straight from navModel.ts in the web's group order, so this screen
// never needs editing when a section is added or built.

import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { moreGroups, type NavItem } from '../navModel'
import { font, radius, space, theme } from '../theme'

export default function MoreScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const groups = moreGroups()

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.intro}>
        Every Mission Control section. The four on the tab bar are the ones you
        reach for; these are everything else.
      </Text>

      {groups.map((g) => (
        <View key={g.id} style={s.group}>
          <Text style={s.groupLabel} accessibilityRole="header">
            {g.label}
          </Text>
          <View style={s.card}>
            {g.items.map((item, i) => (
              <Row key={item.id} item={item} first={i === 0} onPress={() => onOpen(item.id)} />
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

function Row({ item, first, onPress }: { item: NavItem; first: boolean; onPress: () => void }) {
  // Status is carried by a word, not a colour: 'Ready' rows say nothing (they just
  // work), and the rest are tagged in text. A tint is applied on top for the people
  // who can use it, but no meaning depends on it (theme.ts).
  const tag = item.status === 'ready' ? null : item.status === 'planned' ? 'Planned' : 'Not built'
  const tagColor = item.status === 'planned' ? theme.textDim : theme.textFaint

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.label}${tag ? `, ${tag}` : ''}. ${item.blurb}`}
      accessibilityHint={
        item.status === 'ready' ? undefined : 'Opens a page explaining what this section will show.'
      }
      onPress={onPress}
      style={({ pressed }) => [s.row, !first && s.rowDivider, pressed && { backgroundColor: theme.s2 }]}
    >
      <Text style={s.glyph}>{item.glyph}</Text>
      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={s.rowLabel}>{item.label}</Text>
          {tag ? <Text style={[s.tag, { color: tagColor }]}>{tag}</Text> : null}
        </View>
        <Text style={s.rowBlurb} numberOfLines={2}>
          {item.blurb}
        </Text>
      </View>
      <Text style={s.chevron}>›</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, paddingBottom: space.xxl },
  intro: { color: theme.textDim, fontSize: font.sm, lineHeight: 19, marginBottom: space.lg },
  group: { marginBottom: space.xl },
  groupLabel: {
    color: theme.textFaint,
    fontSize: font.sm - 1,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: space.sm,
    marginLeft: space.xs,
  },
  card: {
    backgroundColor: theme.s1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: theme.s3,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: space.md,
    minHeight: 60, // comfortably above the 44pt iOS touch-target floor
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: theme.s3 },
  glyph: { fontSize: 20, width: 26, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowLabel: { color: theme.text, fontSize: font.base, fontWeight: '700' },
  tag: { fontSize: font.sm - 2, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  rowBlurb: { color: theme.textDim, fontSize: font.sm, marginTop: 2, lineHeight: 17 },
  chevron: { color: theme.textFaint, fontSize: 22, fontWeight: '600' },
})
