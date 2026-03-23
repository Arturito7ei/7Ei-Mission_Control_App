# Sprint Status — 7Ei Mission Control App

**Last updated:** 2026-03-23  
**Backend:** v0.6.0 · **Mobile:** v1.0.0 · **Web:** v1.0.0

---

## Sprints 0–13 — Complete ✅
All features, design system, deployment infra, launch polish.

---

## Sprint 14 — Launch Readiness ✅

### Landing page (`web/app/page.tsx`)
- Full marketing page at `7ei.ai`
- Sticky nav with glassmorphism blur
- Hero with animated hexagon mark
- 8 feature cards, model grid (6 models × 3 providers)
- How it works (4 steps), open source section, CTA, footer
- Fully responsive, dark (#070707) with purple (#893BFF) accents
- No external libraries — pure Next.js + inline styles

### Global Search (`app/app/search/index.tsx`)
- Instant cross-entity search: agents, tasks, projects, skills
- Fuzzy match on name, role, title, description, input/output
- StatusBadge + PriorityBadge on results
- Quick-access links when query is empty
- Auto-focus on open, cancel button

### Deep Links (`app/lib/deep-links.ts`)
- `7ei://agent/:id` → agent chat
- `7ei://project/:id` → project board
- `7ei://jira` → Jira screen
- `7ei://search` → global search
- `7ei://onboarding`, `7ei://settings`, `7ei://scheduled`
- Cold-start + warm-start support via `Linking.getInitialURL()`
- `7ei://gmail/callback` handled by Expo AuthSession automatically

### Backend Tests (`backend/src/tests/`)
- `scheduler.test.ts` — cron parsing, calcNextRun, field matching (16 assertions)
- `memory.test.ts` — extract/format memory, edge cases (12 assertions)
- `orchestrator.test.ts` — delegate parsing, stripping (10 assertions)
- `outbound-webhooks.test.ts` — parse/strip webhook tags (8 assertions)
- `llm-router.test.ts` — cost calc, model catalogue validation (9 assertions)
- Run: `npm test` (Node 20 native test runner, no jest dependency)
- All tests run in CI (`test.yml` workflow: backend tests + mobile typecheck + web build)

### Performance Utilities (`app/lib/performance.ts`)
- `LIST_PERF_PROPS` — standard FlatList perf config
- `fixedHeightLayout()` — `getItemLayout` factory
- `throttle()` / `debounce()` — search and input optimisation
- `memoItem()` — typed memo wrapper for list items

### Zustand Store (`app/store/index.ts`)
- Added `skills` slice with `setSkills`
- Added `updateTask`, `addTask` for optimistic updates
- Added `isLoading` / `setIsLoading` / `error` / `setError` UI state

### CI Additions
- `.github/workflows/test.yml` — runs on push + PR:
  - Backend: typecheck + unit tests
  - Mobile: TypeScript typecheck
  - Web: Next.js build

---

## 🎉 v1.0 is code-complete

Every feature is built. Every screen exists. Tests pass. Infra is configured.

**10 ops tasks remaining to go live:**

| Task | Command / Location |
|------|-------------------|
| EAS Project ID | `cd app && eas init` |
| Apple Team ID | developer.apple.com → add to `eas.json` |
| GitHub CI secrets | Settings → Secrets: `FLY_API_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |
| Turso DB | `turso db create 7ei-production --location fra` |
| Pinecone index | console.pinecone.io → 7ei-knowledge, dim=1536, cosine, AWS us-east-1 |
| Upstash Redis | console.upstash.com → eu-central-1 |
| Deploy backend | `flyctl secrets set ... && flyctl deploy` |
| Deploy web | `vercel --prod` |
| Build mobile | `eas build --platform all --profile production` |
| Submit to stores | `eas submit --platform all --profile production` |
