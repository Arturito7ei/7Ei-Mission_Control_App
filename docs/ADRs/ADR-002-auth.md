# ADR-002 — Authentication

**Date:** 2026-03-20  
**Status:** Accepted

## Context

App needs Google OAuth on both mobile and web. Users may also invite team members. Need to avoid managing passwords.

## Decision

Use **Clerk** for authentication:
- Google OAuth as primary provider
- Email magic link as fallback
- Clerk SDK handles token refresh, session management, and JWKS on the backend
- Mobile: Clerk Expo SDK with WebBrowser for OAuth redirect
- Web: Clerk Next.js middleware

## Consequences

- No custom auth code to maintain
- Vendor dependency (Clerk) — acceptable at this stage
- Team invites handled via Clerk organisations feature (maps to 7Ei org model)
- JWT verified on Fastify backend via `@clerk/fastify`
