# ADR-001 — Tech Stack

**Date:** 2026-03-20  
**Status:** Accepted

## Context

Need a stack that works on iOS, Android, and web from a single codebase, with a backend capable of managing LLM API calls, streaming, and agent orchestration.

## Decision

| Layer | Technology | Rationale |
|-------|-----------|----------|
| Mobile | React Native + Expo SDK 51 | Single codebase for iOS + Android; Expo simplifies builds and OTA updates |
| Web | Next.js 15 (App Router) | SSR + client-side, shares components with RN via shared UI lib |
| Shared UI | `packages/ui` — React Native Web | Share primitive components across mobile and web |
| Backend | Node.js + TypeScript + Fastify | Fast, typed, lightweight; good WebSocket support for live agent streams |
| Database | SQLite (local dev) → Turso (production) | Serverless SQLite; simple schema, easy migrations |
| Auth | Clerk (Google OAuth + email) | Handles mobile + web OAuth flows without custom auth code |
| State | Zustand (client) + React Query (server state) | Minimal boilerplate; separate concerns |
| Monorepo | Turborepo | Shared packages, parallel builds, caching |

## Consequences

- React Native Web adds complexity but enables true code sharing
- Turso gives SQLite semantics at scale without a heavy DB server
- Clerk simplifies Google OAuth on both platforms at the cost of a vendor dependency
