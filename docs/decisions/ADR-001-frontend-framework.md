# ADR-001 — Frontend Framework

**Status:** PROPOSED
**Date:** 2026-03-20
**Decider:** Human (pending)

## Context

The app targets iOS, Android, and Web from a single codebase where possible.

## Options

### Option A: React Native (Expo) + Next.js (Recommended)
- **Mobile:** Expo SDK — managed workflow, OTA updates, EAS builds
- **Web:** Next.js 15 App Router — shared components via `@7ei/ui` package
- **Shared:** React + TypeScript across both
- **Pros:** One team, one language, strong ecosystem, Vercel deployment
- **Cons:** Native performance ceiling, RN bridge overhead

### Option B: Flutter + Next.js
- **Mobile:** Flutter (Dart) — excellent native performance, single codebase iOS+Android
- **Web:** Next.js (separate, no code sharing)
- **Pros:** Best-in-class mobile UI
- **Cons:** Two codebases (Dart + JS), harder to share logic

### Option C: Capacitor (Ionic) + Next.js
- Web-first wrapped as mobile
- **Pros:** True single codebase
- **Cons:** WebView performance, not truly native

## Recommendation

**Option A (Expo + Next.js)** — best balance of code sharing, developer velocity, and ecosystem maturity. Start with Expo Go for development, migrate to EAS builds for production.

## Decision

PENDING human confirmation.
