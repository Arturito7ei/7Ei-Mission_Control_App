# ADR-001 — Technology Stack

**Date:** 2026-03-20  
**Status:** Proposed  
**Decider:** arturito@7ei.ai

## Context

We need to choose the core technology stack for:
1. Mobile app (iOS + Android)
2. Web desktop app
3. Backend API + agent runtime
4. Database

## Decision

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Mobile | React Native (Expo) | Single codebase for iOS + Android; large ecosystem; matches web skills |
| Web Desktop | Next.js 15 | SSR + SSG; same React component library as mobile where possible |
| Backend | Node.js + TypeScript | Type safety; matches frontend language; strong LLM SDK support |
| Primary LLM | Anthropic Claude API | Most capable for agent orchestration; used in 7Ei_OS |
| LLM Adapter | Modular adapter pattern | Allows swapping to GPT, Gemini, Grok without rewrite |
| Auth | Google OAuth 2.0 | Users already in Google ecosystem; simplifies Drive integration |
| Database | SQLite (local) + Supabase (cloud sync) | Offline-capable; easy to self-host; Supabase for team sync |
| Storage | Google Drive API (v1) | Most users already have Drive; modular for OneDrive/Dropbox later |
| CI/CD | GitHub Actions + Vercel | Free tier covers dev needs; Vercel auto-deploy for web |

## Alternatives Considered

- **Flutter** — rejected: Dart ecosystem less mature for LLM integrations
- **Native Swift/Kotlin** — rejected: doubles development cost
- **Python backend** — rejected: team more fluent in TS; Node LLM SDKs are excellent
- **Firebase** — rejected: vendor lock-in; Supabase is open-source equivalent

## Consequences

- React Native components can be shared with Next.js via a shared `packages/ui` library
- TypeScript end-to-end reduces runtime bugs
- Google OAuth requires an approved Google Cloud project
- SQLite means offline mode works out of the box

## Review Date

Revisit after Sprint 1 once first build is on device.
