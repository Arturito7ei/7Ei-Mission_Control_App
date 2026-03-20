# 7Ei Mission Control App — CLAUDE.md

## Operating System
Follow all protocols from 7Ei_OS (github.com/Arturito7ei/7Ei_OS).
Key protocols: memory, workflow, learning, principles, governance.

## This Project
- **Purpose:** Mobile-first AI virtual office platform (iOS, Android, Web)
- **Tech stack:** React Native (Expo) + Next.js 15, Supabase, BullMQ, Vercel AI SDK
- **Repo:** `Arturito7ei/7Ei-Mission_Control_App`
- **Google Drive:** https://drive.google.com/drive/folders/1Yz2DtytbF63lbKuif51gk3M2SrZRjsyq
- **Status:** Phase 0 — Foundation

## Conventions
- Branch prefix: `claude/<description>-<session-id>`
- Commit prefix: `mc:` for this repo
- All module specs live in `docs/modules/`
- Architecture decisions live in `docs/decisions/ADR-NNN-*.md`
- Follow `ROADMAP.md` phase order — do not jump ahead

## Key Files
- `PRODUCT.md` — full feature spec and module breakdown
- `ARCHITECTURE.md` — technical stack and system design
- `ROADMAP.md` — iteration plan with checkboxes
- `docs/modules/` — per-module detailed specs
- `docs/decisions/` — Architecture Decision Records

## Agent Context
- This app implements the 7Ei_OS agent model in a product
- Agents in the app follow the same knowledge layer architecture (L0–L4)
- The `skill-library` repo feeds the in-app skill module (M5)
- Arturito7EiClaude is the primary agent working on this repo
