# ADR-001 — Tech Stack Selection

**Date:** 2026-03-20
**Status:** Accepted

## Context

The app must run on iOS, Android, and web from a single codebase, with real-time agent status and chat. We need to move fast and maintain production quality from the start.

## Decision

**Mobile:** React Native + Expo
- Single codebase for iOS + Android
- Expo managed workflow reduces native config overhead
- Large ecosystem, well-suited for rapid iteration

**Web:** Next.js
- Share React component logic with the mobile app
- API routes for backend — no separate server to start
- Vercel deployment is trivial

**Database + Auth:** Supabase
- PostgreSQL with Row-Level Security for multi-tenant data isolation
- Built-in auth (email, OAuth)
- Real-time subscriptions for live task log and agent status
- Storage bucket for file attachments

**UI:** NativeWind or Tamagui — decide during Phase 1 scaffolding

**LLM Gateway:** Direct API calls per agent config
- Each agent stores its model + API key (encrypted in Supabase Vault)
- Centralised gateway service extracted in v2 if needed

## Alternatives Rejected

- **Flutter:** Faster rendering but Dart ecosystem is narrower; team is JS-native
- **Firebase:** Less control over data model; PostgreSQL preferred for relational org data
- **Separate backend (Fastify/Express):** Premature — Next.js API routes sufficient for Phase 1-3

## Consequences

- Shared component library between mobile and web requires discipline (Tamagui handles this well)
- Real-time task log is native to Supabase — no extra infra
- LLM keys stored per-agent in Supabase Vault — must enforce RLS strictly
