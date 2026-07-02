# web/ — Next.js 15 App Router on Vercel (app.7ei.ai) — PRIMARY UI

Loads on top of the root CLAUDE.md when working in `web/`.

## Verify

```bash
npm run build   # production build must pass before merging
```

Vercel deploy lags ~2 min after merge — reload `app.7ei.ai` after it completes before judging changes.

## Structure

- `app/dashboard/` — panels: `CockpitPanel.tsx` (oversized, split when touching), `ConnectorsPanel.tsx`, `GovernancePanel.tsx`, `MemoryPanel.tsx`, `TaskDrawer.tsx`.
- `app/dashboard/tokens.ts` — design tokens (MCA-70). Use tokens for colors/spacing/type; do NOT hardcode values in new UI.
- Auth: Clerk (currently a dev instance — production instance pending, see `GO-LIVE.md` §1).

## Conventions

- Single-file panels calling the backend with inline `fetch`. There is no shared API client yet — when adding or touching fetch calls, prefer extracting into a shared helper (`lib/api.ts`) rather than duplicating auth headers again.
- A11y (MCA-73): interactive rows keyboard-focusable, drawers close on ESC, respect responsive breakpoints.
- PWA: manifest + installable (MCA-65) — don't break `manifest` route or viewport/theme meta.
