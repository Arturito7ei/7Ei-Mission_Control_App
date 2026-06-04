# 7Ei Mission Control — Project Status

_Last updated: 2026-06-04_

A snapshot of what's live, what's done, and what's next. Tracked in Jira project
[**MCA**](https://7ei.atlassian.net/browse/MCA-1) (`7ei.atlassian.net`).

## Overview

Monorepo (`Arturito7ei/7Ei-Mission_Control_App`):

| Workspace | Stack | Hosting | URL |
|---|---|---|---|
| `backend/` | Fastify · Drizzle · Turso (Node 22) | Fly.io (`7ei-backend`, region `fra`) | https://7ei-backend.fly.dev |
| `web/` | Next.js 15 App Router | Vercel (`7ei-mission-control-app`) | https://app.7ei.ai |
| `app/` | Expo (React Native) | iOS / Android | — |

## Live now

- **`app.7ei.ai`** — Clerk login, organisation creation + settings, multi-model selection, and document upload → summary, all talking to the live backend.
- **CI auto-deploys on merge to `main`** (backend → Fly, web → Vercel).

## Completed this phase

| Area | Jira | PR |
|---|---|---|
| Web app go-live on Vercel | [MCA-1](https://7ei.atlassian.net/browse/MCA-1) / [MCA-7](https://7ei.atlassian.net/browse/MCA-7) | — |
| Next.js 15.2.4 → 15.5.19 (Vercel security gate) | [MCA-8](https://7ei.atlassian.net/browse/MCA-8) | [#111](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/111) |
| `NEXT_PUBLIC_API_URL` → backend | [MCA-9](https://7ei.atlassian.net/browse/MCA-9) | — |
| `app.7ei.ai` DNS (Namecheap A → 76.76.21.21) | [MCA-10](https://7ei.atlassian.net/browse/MCA-10) | — |
| Clerk middleware fix → login works | [MCA-11](https://7ei.atlassian.net/browse/MCA-11) | [#112](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/112) |
| Clerk dev keys in Vercel | [MCA-12](https://7ei.atlassian.net/browse/MCA-12) | — |
| Web organisation-creation form | [MCA-15](https://7ei.atlassian.net/browse/MCA-15) | [#113](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/113) |
| Org Settings tab (mission/culture edit) | [MCA-16](https://7ei.atlassian.net/browse/MCA-16) | [#116](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/116) |
| OpenAI-compatible + custom LLM providers | [MCA-18](https://7ei.atlassian.net/browse/MCA-18) | [#114](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/114) |
| Data-driven model picker + custom API | [MCA-19](https://7ei.atlassian.net/browse/MCA-19) | [#113](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/113) |
| Document upload → summary → shared knowledge | [MCA-20](https://7ei.atlassian.net/browse/MCA-20) | [#116](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/116) |
| Fix Deploy workflow (auto-deploy on merge) | [MCA-22](https://7ei.atlassian.net/browse/MCA-22) | [#115](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/115) |

## Open / backlog

| Item | Jira | Notes |
|---|---|---|
| Verify org creation end-to-end (TARCO) | [MCA-17](https://7ei.atlassian.net/browse/MCA-17) | Last unverified link — confirms backend accepts the Clerk token |
| Clerk production instance + DNS | [MCA-13](https://7ei.atlassian.net/browse/MCA-13) | For real users; needs Clerk CNAMEs at Namecheap |
| Backend Clerk token enforcement on Fly | [MCA-14](https://7ei.atlassian.net/browse/MCA-14) | Review auth middleware before enabling |
| Enable Pinecone for RAG retrieval | [MCA-21](https://7ei.atlassian.net/browse/MCA-21) | `pinecone:false` today; needs `PINECONE_API_KEY` on Fly |
| Bump GitHub Actions (Node 24) | [MCA-23](https://7ei.atlassian.net/browse/MCA-23) | `actions/checkout@v4` Node-20 deprecation (Sept 2026) |

## Multi-model LLM support

The router (`backend/src/services/llm-router.ts`) speaks any OpenAI-compatible API:
**Anthropic · OpenAI · Google · DeepSeek · Kimi (Moonshot) · Qwen · MiniMax · Ollama · custom**.
Per-org credentials live in `org.deployConfig['<provider>_api_key' / '_base_url']`. `GET /api/models`
serves the catalogue to the web picker.

## Architecture notes / gotchas (learned the hard way)

- **Next.js middleware** must live at `web/middleware.ts` (the `app/` dir is at the workspace root, not `src/`) or it silently never runs — this broke Clerk route protection.
- **Vercel hard-blocks** deploying vulnerable Next.js versions.
- **GitHub Actions:** the `secrets` context is invalid in a job-level `if:` — gate steps with `if: ${{ env.X }}` after copying secrets to job `env`.
- **Clerk** is on a **dev** instance today; mission/culture text is injected directly into every agent (no Pinecone needed), while uploaded-doc RAG search waits on Pinecone.

## Deploy

- **Automatic:** merge to `main` → `Deploy` workflow ships backend → Fly and web → Vercel.
- **Manual:** `cd backend && flyctl deploy --remote-only --app 7ei-backend` · `cd web && vercel --prod`.
