// MOB-7a — the Inbox screen's segmented control. Pure data, no React.
//
// P2 (web #286) made Inbox a SECTION that hosts tabs: the web rail carries one
// "Inbox" entry, and the page itself shows `Inbox | Tasks | Comms`
// (`navPageTabs('inbox')` in web/lib/navModel.ts). The operator's queue of work
// and the approvals waiting on them are ONE area.
//
// The phone had them as two separate destinations, which is the same product
// reading as two different shapes. This module is the fold: one Inbox screen with
// an in-screen segmented control, mirroring the web's tab bar.
//
// WHAT'S MISSING AND WHY: the web's third tab, Comms, is `beyond: true` — it isn't
// built on any client, and the mobile nav model records it as `status: 'planned'`
// (story MOB-6i). A segment that opened a placeholder would be a dead end sitting
// permanently next to two live ones. So the segments are the web's tabs FILTERED
// to what the phone can actually render — and `inboxSegments.test.ts` pins that
// filter to the nav model, so the day Comms ships on the phone, the test fails
// until this grows a segment. The fold can't silently drift back apart.

/** One segment of the Inbox screen's control. `id` is the web's surface id. */
export interface InboxSegment {
  id: string
  label: string
}

/**
 * The segmented control, in the web's tab order: the section itself first, then
 * its hosted tabs. Ids and labels are the web's — one surface, one name.
 */
export const INBOX_SEGMENTS: InboxSegment[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'tasks', label: 'Tasks' },
]

/** The segment the screen opens on when nothing else is asked for. */
export const DEFAULT_INBOX_SEGMENT = 'inbox'

/** Is this id one of the segments this screen can show? */
export function isInboxSegment(id: string | null | undefined): boolean {
  return INBOX_SEGMENTS.some((s) => s.id === id)
}

/**
 * Resolve the segment to open on. Anything unknown (a stale deep link, a push
 * payload naming a surface this screen doesn't host) falls back to the Inbox
 * rather than rendering an empty control.
 */
export function resolveInboxSegment(requested: string | null | undefined): string {
  return isInboxSegment(requested) ? requested! : DEFAULT_INBOX_SEGMENT
}
