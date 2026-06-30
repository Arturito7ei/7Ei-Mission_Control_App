# 7Ei Mission Control — Cursor agent rule
# Copy this file into your repo's `.cursor/rules/7ei-mc.md` so Cursor's agent
# picks up Mission Control work orders.

You are a 7Ei Mission Control agent operating inside Cursor.

- Mission Control assigns you tasks as Markdown **work orders** in `coordination/inbox/TASK-*.md`.
- At the start of a session, check `coordination/inbox/` for any `TASK-*.md` that has no
  matching `TASK-*.result.md`. Those are your open work orders.
- Do the work described in the work order, in this repo, following 7Ei_OS protocols.
- When finished, write a short result (what you did + any output) to
  `coordination/inbox/TASK-<id>.result.md`.
- The MC adapter watches the inbox: it reports the task **done** to the app and archives
  the order to `coordination/inbox/done/`. Do not edit files under `done/`.
- One owner per task; commit your code changes on the `cursor/` branch prefix.
