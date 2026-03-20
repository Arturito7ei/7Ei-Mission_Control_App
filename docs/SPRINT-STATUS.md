# Sprint Status — 7Ei Mission Control App

**Last updated:** 2026-03-20  
**Current phase:** All sprints scaffolded. Ready for install + run.

---

## Sprint 0 — Foundation ✅
- Monorepo (`app/`, `web/`, `backend/`)
- Tech stack confirmed (Expo + Next.js 15 + Fastify)
- ADRs: stack, auth, storage, agent protocol
- GitHub Actions CI
- Auth: Clerk (Google OAuth on mobile + web)

## Sprint 1 — Org Manager + Agent Studio ✅
- Backend: full DB schema + all routes
- Mobile: all 5 tab screens built
- Agent creation flow with templates (Arturito, Dept heads, Silver Board)
- Org creation screen
- API client (typed, all endpoints)
- Zustand store + design tokens

## Sprint 2 — Knowledge Base ✅ (structure ready)
- Google Drive adapter in backend
- Knowledge tab screen (browse + save items)
- File reading via Google Drive API

## Sprint 3 — Task Log + Cost Centre ✅
- Tasks tab with filter chips (all / pending / in_progress / done / blocked)
- Cost Centre tab with bar chart per agent and per day
- Period toggles (7d / 30d / 90d)
- Totals summary cards

## Sprint 4 — Project Management ✅
- Projects list screen
- Create project screen
- Kanban board per project (4 columns)
- Drag-between-columns via move buttons
- Task create screen with agent assignment

## Sprint 5 — Skill Library ✅
- Skills screen with domain grouping
- GitHub sync (pulls SKILL.md from Arturito7ei/skill-library)
- Skill detail screen with assign-to-agent
- Skills tab in agent detail

## Sprint 6 — Multi-Agent + Silver Board ✅
- Agent creation with 'advisor' type + persona field
- Silver Board section in Org Chart
- Org Chart screen (hierarchical layout)

## Sprint 7 — Communications 🔲 (next)
- [ ] Unified inbox screen
- [ ] Gmail integration read/send
- [ ] Telegram bot plugin
- [ ] Google Meet link generation

## Sprint 8 — Web Desktop + Polish ✅ (partial)
- Web dashboard with sidebar nav built
- 4 tabs: Overview, Agents, Tasks, Cost Centre
- Auth guard (Clerk + redirect)
- Remaining: full feature parity pass, onboarding flow

---

## Setup Guide

### Prerequisites
- Node 20+
- Expo CLI: `npm install -g expo`
- iOS Simulator (Xcode) or Android emulator

### Backend
```bash
cd backend
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, CLERK_SECRET_KEY
npm install
npm run dev
# → http://localhost:3001/health
```

### Mobile
```bash
cd app
cp .env.example .env.local
# Fill in: EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
npm install
npx expo start
# Press i (iOS) or a (Android)
```

### Web
```bash
cd web
cp .env.example .env.local
# Fill in: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
npm install
npm run dev
# → http://localhost:3000
```

### First run flow
1. Sign in with Google (mobile or web)
2. Create an organisation
3. Tap “+ New Agent” → select Arturito template
4. Open the chat tab → send a message
5. Get a Claude-powered response ✅
