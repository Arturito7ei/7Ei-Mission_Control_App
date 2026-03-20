# Sprint 0 Status

**Goal:** Skeleton app running on device. Google login works. Tabs navigate.

## Checklist

### ✅ Done
- [x] Monorepo structure (`app/`, `web/`, `backend/`)
- [x] Tech stack confirmed — ADR-001
- [x] Auth approach confirmed — ADR-002
- [x] Storage interface confirmed — ADR-003
- [x] Agent protocol confirmed — ADR-004
- [x] GitHub Actions CI (lint + typecheck + build)
- [x] `.gitignore` with full coverage
- [x] Backend: Fastify skeleton with health check + route stubs
- [x] Backend: DB schema (organisations, departments, agents, tasks, projects)
- [x] Mobile: Expo + expo-router skeleton with 5 tabs
- [x] Mobile: Google OAuth sign-in screen (Clerk)
- [x] Web: Next.js 15 skeleton with Clerk auth

### 🔲 To Do
- [ ] Install dependencies: `npm install` in each workspace
- [ ] Add `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` to `app/.env.local`
- [ ] Add `CLERK_SECRET_KEY` to `backend/.env`
- [ ] Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to `web/.env.local`
- [ ] Run `expo start` → verify iOS + Android simulator boot
- [ ] Run `next dev` → verify web login works
- [ ] Run backend → verify `/health` returns 200
- [ ] Design system pass: define 7Ei color tokens (`#0a0a0a`, `#ffffff`, `#888888`, brand accent TBD)

## Definition of Done
> App runs on iOS simulator and Android emulator. Google login works. Tabs navigate.

## Next → Sprint 1
Org Manager + Agent Studio. User can create an org, spin up Arturito, and send a message that gets a Claude-powered response.
