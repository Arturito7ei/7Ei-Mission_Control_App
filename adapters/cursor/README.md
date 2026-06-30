# Cursor runtime adapter (MCA-EXT, Phase 4)

Bridges Mission Control's task queue to a filesystem **inbox** that Cursor works in.
Unlike the OpenClaw adapter (which executes autonomously), Cursor is human-in-the-IDE,
so this adapter hands work orders in and watches for results.

```
MC assigns task ─▶ cursor_adapter.py ─claim─▶ coordination/inbox/TASK-<id>.md
                                                      │ Cursor (agent/human) does the work
                                                      ▼ writes TASK-<id>.result.md
MC task = done ◀─ POST /result ◀── cursor_adapter.py detects result ── archives to inbox/done/
```

## Onboard
Create the agent with `runtime: "cursor"` (cockpit → Add agent → Cursor, or
`POST /api/orgs/:id/agents/external`). Copy the one-time token.

## Install & run (in the Cursor repo)
```bash
export MC_BASE_URL=https://7ei-backend.fly.dev
export MC_AGENT_TOKEN=mca_...        # from onboarding
export MC_INBOX="$PWD/coordination/inbox"
python3 path/to/cursor_adapter.py --once   # one pass
python3 path/to/cursor_adapter.py          # poll loop
```
Drop `cursor-rules-7ei-mc.md` into the repo's `.cursor/rules/7ei-mc.md` so Cursor's agent
knows to watch `coordination/inbox/` and write `TASK-<id>.result.md` when done.

## Verify
`backend/scripts/smoke-cursor.ts` (`npm run smoke:cursor`) seeds an assigned task, runs the
adapter (pass 1 → work order), simulates Cursor writing a result, runs the adapter again
(pass 2 → posts done), and asserts the task reaches **done** with the result text.
