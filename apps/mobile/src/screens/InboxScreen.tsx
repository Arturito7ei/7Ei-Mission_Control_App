// MOB-7a — the Inbox: approvals and the Task Log, in ONE place.
//
// THE FOLD. P2 (web #286) made Inbox a section that hosts tabs — the web rail has
// a single "Inbox" entry and the page shows `Inbox | Tasks | Comms`, because the
// operator's queue of work and the approvals waiting on them are one area. The
// phone had shipped them as two separate destinations: same product, two shapes.
// This screen is the phone's peer of that tabbed page — one screen, an in-screen
// segmented control, approvals under Inbox and the Task Log under Tasks.
//
// The panes themselves are untouched:
//   * Inbox → InboxSegmentPane — attention queue (S6) + ApprovalsPane. THE MOB-4
//     STEP-UP FLOW inside ApprovalsPane is UNCHANGED, deliberately: approve/reject/
//     request-changes and the on-device step-up gate are the same code they were,
//     because a layout change must not reach into the gate that gets dangerous
//     actions approved from a phone.
//   * Tasks → TasksScreen — the MOB-6b Task Log, unchanged.
//
// `tasks` is still a destination in its own right (the nav model must keep one for
// every web surface, and More still lists it) — navigation.tsx routes it HERE, on
// the Tasks segment. The fold is about where Tasks renders, not whether it exists.
//
// The segments themselves are ../inboxSegments, pinned to the web's
// `navPageTabs('inbox')` by its test — including a tripwire that fails the day
// Comms becomes renderable on the phone and this control hasn't grown a segment.

import React, { useCallback, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { INBOX_SEGMENTS, isInboxSegment, resolveInboxSegment } from '../inboxSegments'
import { font, space, theme } from '../theme'
import type { ScreenNav } from '../navigation'
import InboxSegmentPane from './InboxSegmentPane'
import ChatPane from './ChatPane'
import TasksScreen from './TasksScreen'

export default function InboxScreen({
  initialSegment,
  onOpenTab,
}: ScreenNav & { initialSegment?: string }) {
  const [segment, setSegment] = useState(() => resolveInboxSegment(initialSegment))

  /**
   * The Task Log's approvals affordance calls `onOpenTab('inbox')` — the web's
   * `selectTab('inbox')`. Before the fold that was a tab jump; now Inbox is a
   * SEGMENT of this very screen, so it must switch the control rather than
   * navigate (navigating would land right back here, on the Tasks segment, having
   * visibly done nothing). Anything that isn't one of our segments is a real
   * destination and still goes to the navigator.
   */
  const openTab = useCallback(
    (tab: string) => {
      if (isInboxSegment(tab)) setSegment(tab)
      else onOpenTab?.(tab)
    },
    [onOpenTab],
  )

  return (
    <View style={s.wrap}>
      {/* The web's Inbox|Tasks tab bar, as a native segmented control. */}
      <View style={s.segments} accessibilityRole="tablist">
        {INBOX_SEGMENTS.map((seg) => {
          const active = seg.id === segment
          return (
            <Pressable
              key={seg.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={seg.label}
              onPress={() => setSegment(seg.id)}
              style={({ pressed }) => [s.segment, active && s.segmentOn, pressed && { opacity: 0.7 }]}
            >
              {/* Selection reads from weight + the underline + the a11y state, not
                  from hue alone — the same colorblind rule as everything else here. */}
              <Text style={[s.segmentText, active && s.segmentTextOn]}>{seg.label}</Text>
            </Pressable>
          )
        })}
      </View>

      <View style={s.pane}>
        {/* The Task Log is read-only and takes only `onOpenTab` — it drills into
            no agent, so there is no onOpenAgent to forward. */}
        {/* MCC-1 — the Chat segment renders the agent-conversation pane. */}
        {segment === 'chat' ? (
          <ChatPane />
        ) : segment === 'tasks' ? (
          <TasksScreen onOpenTab={openTab} />
        ) : (
          <InboxSegmentPane />
        )}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  segments: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.s3,
  },
  segment: {
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -1,
  },
  segmentOn: { borderBottomColor: theme.blue },
  segmentText: { color: theme.textDim, fontSize: font.base, fontWeight: '600' },
  segmentTextOn: { color: theme.text, fontWeight: '800' },
  pane: { flex: 1 },
})
