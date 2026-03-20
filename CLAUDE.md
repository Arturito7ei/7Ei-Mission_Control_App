# 7Ei Mission Control App — CLAUDE.md

## Operating System
Follow all protocols from 7Ei_OS (github.com/Arturito7ei/7Ei_OS).
Key protocols: memory, workflow (plan → execute → verify), governance, learning.

## This Project
- **Purpose:** Mobile + web app for managing AI-powered virtual organisations
- **Roadmap:** `ROADMAP.md` — follow phases in order, check exit criteria before advancing
- **Product spec:** `PRODUCT.md` — full feature and module definition
- **Architecture:** `ARCHITECTURE.md` — stack and data model
- **Stack:** React Native + Expo (mobile), Next.js (web), Supabase (DB + auth + realtime)
- **Org:** `Arturito7ei` on GitHub
- **Google Drive:** https://drive.google.com/drive/folders/1Yz2DtytbF63lbKuif51gk3M2SrZRjsyq

## Conventions
- Branch prefix: `claude/<description>-<session-id>`
- Commit scopes: `app:`, `api:`, `ui:`, `db:`, `docs:`, `fix:`
- Never commit `.env` or API keys
- New modules get a spec doc in `docs/modules/` before code is written
- Architecture decisions go in `docs/decisions/ADR-NNN-title.md`
- Check `ROADMAP.md` phase exit criteria before starting the next phase

## Current Phase
Phase 0 complete. Next: Phase 1 — Skeleton.
Phase 1 starts with: scaffold React Native + Expo project.
