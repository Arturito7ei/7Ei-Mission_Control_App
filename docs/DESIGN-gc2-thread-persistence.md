# GC-2 — Command Center thread persistence

**Status:** in flight · **Sprint:** S2 · **Baseline:** `d37d4be`

Command Center (`POST /api/orgs/:orgId/arturita/converse`) kept history in client
`useState` — it died on refresh. GC-1 added the agent picker but deliberately avoided a
server store. GC-2 adds one.

## Model

| Table | Purpose |
|---|---|
| `command_center_threads` | One row per `(org_id, target_agent_key)` — Arturita = `''`, specialist = agent uuid |
| `command_center_turns` | Append-only turns; display metadata in `meta_json` |

**Not stored:** attachment bytes, image pixels, raw `history` arrays from the client.
Attachment/image *names* appear in the user bubble text (same as the UI chip labels).

**Thread key resets:** when the operator switches the GC-1 picker recipient, they load
that agent's thread (separate row). Matches `threadRef` reset on switch.

**Task follow-up:** `task_thread_id` on the thread row holds the latest delegate/agent
`taskId` for `existingThreadId` continuity.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/orgs/:orgId/arturita/thread?agentId=` | Load turns + `taskThreadId`; `agentId` absent = Arturita |
| POST | `/api/orgs/:orgId/arturita/converse` | Unchanged contract; **persists** user + assistant turns after each reply |

Server-built history for LLM context replaces client `history` when a persisted thread
exists (client history still accepted for empty threads / migration).

## Security

- Org-scoped routes behind Clerk membership gate (existing scope).
- `target_agent_key` validated with `assertAgentInOrg` when non-empty.
- No cross-tenant reads: every query filters `org_id` from the path.

## Parity

| Surface | O3 |
|---|---|
| Web `AssistantPanel.tsx` | Hydrate on mount + after recipient switch |
| Mobile `CommandCenterScreen.tsx` | Same via `Api.loadCommandCenterThread` |

MCC-1 Chat tab is a **separate** surface (`messages` table per agent) — out of scope.
