# Sprint Status — 7Ei Mission Control App

**Last updated:** 2026-03-20  
**Current phase:** All 8 sprints complete. App ready to run locally.

---

## Sprint 0 — Foundation ✅
- Monorepo (app/, web/, backend/)
- Expo SDK 51 + Next.js 15 + Fastify
- ADRs: stack, auth, storage, agent protocol
- GitHub Actions CI (backend + web + mobile typecheck)
- Auth: Clerk (Google OAuth mobile + web)

## Sprint 1 — Org Manager + Agent Studio ✅
- Backend: DB schema + all CRUD routes
- Mobile: 5 tab screens, org creation, API client, Zustand store, design tokens
- Agent creation with templates (Arturito, dept heads, Silver Board)
- Agent detail screen with 3-tab layout (Chat / Info / Skills)
- Claude streaming via WebSocket with REST fallback

## Sprint 2 — Knowledge Base ✅
- Google Drive adapter: browse folders + read file content
- Knowledge tab screen with saved items
- Backend routes: browse, read, save, delete

## Sprint 3 — Task Log + Cost Centre ✅
- Tasks tab: filter chips (all / pending / in_progress / done / blocked)
- Cost Centre tab: bar chart by agent or by day, 7d/30d/90d periods
- Totals summary (spend / tokens / task count)
- Agent + cost data enrichment in backend

## Sprint 4 — Project Management ✅
- Projects list + create screens
- Kanban board (4 columns: todo / in_progress / blocked / done)
- Task create screen with agent assignment + priority + column
- Backend board endpoint returns tasks grouped by column

## Sprint 5 — Skill Library ✅
- Skill list with domain grouping
- GitHub sync from Arturito7ei/skill-library
- Skill detail with assign-to-agent
- Agent skills tab shows assigned skills

## Sprint 6 — Multi-Agent + Silver Board ✅
- Agent creation supports 'advisor' type + persona field
- Org Chart screen: orchestrator at top, departments, Silver Board section
- Agent edit screen

## Sprint 7 — Communications Hub ✅
- Backend: comms routes (Gmail API, Telegram bot, Google Meet, unified inbox)
- Push notifications via Expo (register token, send on task completion)
- Mobile: Comms tab (inbox / Gmail / Telegram channels, compose sheet)
- Org Settings screen with Telegram bot setup + integrations list
- Onboarding flow (6-step animated walkthrough)

## Sprint 8 — Web Desktop + Polish ✅
- Web dashboard with 7-tab sidebar: Overview, Agents, Tasks, Projects, Skills, Costs, Comms
- Notification bell + recent activity feed
- Skill sync from web
- Cost breakdown per agent with bar chart
- Home screen upgraded: live cost stat, org chart button, skills + comms quick actions
- Tab layout updated: Comms replaces Knowledge in main nav

---

## What’s left for production

- [ ] App Store submission (Expo EAS build)
- [ ] Jira integration (project key O7MC, Sprint 4 extension)
- [ ] Gmail OAuth flow on mobile (currently requires accessToken from Clerk)
- [ ] Pinecone vector search for knowledge base
- [ ] Multi-org switcher
- [ ] Agent memory persistence (long-term store)
- [ ] Rate limiting + usage caps per org

---

## Setup Guide

### Prerequisites
```bash
node --version  # 20+
npm install -g expo
```

### 1. Backend
```bash
cd backend
cp .env.example .env
# Fill in:
#   ANTHROPIC_API_KEY=sk-ant-...
#   CLERK_SECRET_KEY=sk_test_...
npm install
npm run dev
# → GET http://localhost:3001/health
```

### 2. Mobile
```bash
cd app
cp .env.example .env.local
# Fill in:
#   EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
#   EXPO_PUBLIC_API_URL=http://localhost:3001
npm install
npx expo start
# Press i (iOS) or a (Android)
```

### 3. Web
```bash
cd web
cp .env.example .env.local
# Fill in:
#   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
#   CLERK_SECRET_KEY=sk_test_...
#   NEXT_PUBLIC_API_URL=http://localhost:3001
npm install
npm run dev
# → http://localhost:3000
```

### First run
1. Sign in with Google (mobile or web)
2. Create an organisation
3. New Agent → Arturito template
4. Chat tab → send a message
5. Get a Claude-powered response ✅
