# ADR-002 — Backend Framework

**Status:** PROPOSED
**Date:** 2026-03-20
**Decider:** Human (pending)

## Context

Need a backend that handles: REST API, WebSocket (live task logs), agent job queue, auth, and DB.

## Options

### Option A: Next.js API Routes + Supabase (Recommended for MVP)
- **API:** Next.js App Router Route Handlers
- **DB:** Supabase (PostgreSQL + real-time)
- **Auth:** Supabase Auth or Clerk
- **Queue:** BullMQ + Upstash Redis
- **Hosting:** Vercel
- **Pros:** Minimal infra, fast to ship, integrates with Vercel
- **Cons:** Cold starts on Vercel, limited for heavy compute

### Option B: FastAPI (Python) + Supabase
- **API:** FastAPI (Python)
- **Pros:** Better for AI/ML, async, type-safe
- **Cons:** Second language, more infra overhead
- **Recommendation:** Migrate to this in v2 if agent execution becomes complex

## Recommendation

**Option A** for MVP. Design API contracts cleanly so FastAPI migration is possible in Phase 5.

## Decision

PENDING human confirmation.
