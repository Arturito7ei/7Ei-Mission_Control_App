# Sprint Status — 7Ei Mission Control App

**Last updated:** 2026-03-23
**Backend:** v0.6.0 · **Mobile:** v0.9.0 · **Web:** v0.1.0

---

## Sprints 0–11 — Complete ✅
All core modules, design system, Jira, memory, multi-model, Pinecone, Redis, Gmail OAuth.

---

## Sprint 12 — Production Hardening + New Features ✅

### Deployment
- `backend/Dockerfile` — multi-stage, Alpine, healthcheck
- `backend/fly.toml` — Fly.io Frankfurt (closest to Zürich), 512MB, auto-stop
- `backend/railway.toml` — Railway fallback option
- `web/vercel.json` — Vercel Frankfurt region, security headers
- `.github/workflows/deploy.yml` — auto-deploy backend (Fly) + web (Vercel) on push to main
- `docs/DEPLOY.md` — step-by-step: Fly.io, Turso, Upstash Redis, Pinecone, EAS, CI/CD, custom domains

### Database
- `backend/drizzle.config.ts` — Drizzle Kit config for migrations
- `backend/src/db/migrations/0001_init.sql` — canonical SQL migration file
- `backend/src/db/schema.ts` — added `scheduledTasks` + `webhooks` tables with indexes

### Scheduled Tasks Engine
- `backend/src/services/scheduler.ts` — 1-minute tick, cron parser, auto-start on server boot
- `GET /api/orgs/:orgId/scheduled` — list schedules
- `POST /api/orgs/:orgId/scheduled` — create (with cron preview endpoint)
- `PATCH /api/scheduled/:id` — enable/disable, update cron
- `GET /api/scheduled/preview?cron=...` — preview next run time
- Mobile: full scheduled tasks screen (presets, custom cron, toggle, delete)

### Agent Orchestration Protocol
- `backend/src/services/orchestrator.ts` — `[DELEGATE: AgentName | task]` parsing
- Arturito auto-routes tasks to specialist agents via delegation tags
- Results synthesised into a single response automatically
- Parallel execution of all delegations (Promise.allSettled)
- System prompt update for orchestrator agents

### Outbound Webhooks
- `backend/src/services/outbound-webhooks.ts` — platform events + agent-triggered calls
- Platform events: task.done, task.failed, agent.active, agent.idle, message.created
- Agent protocol: `[WEBHOOK: https://... | {"json":"payload"}]` in response
- HMAC-SHA256 signatures (X-7Ei-Signature header)
- 10s timeout, non-blocking delivery
- `GET /api/orgs/:orgId/webhooks` — list (secrets masked)
- `POST /api/orgs/:orgId/webhooks` — create
- `POST /api/webhooks/:id/test` — ping test
- Mobile: full webhooks screen (create, test, delete, event picker)

### Security
- `@fastify/helmet` added — security headers on all responses
- `trustProxy: true` for Fly.io / Railway proxy
- Production CORS: locked to 7ei.ai domains
- Healthcheck + readiness endpoints

### App Store Metadata
- `docs/APP_STORE.md` — full iOS + Android metadata, screenshot guide

---

## v1.0 Final Checklist

- [x] All features built (Sprints 0–12)
- [x] Dockerfile + Fly.io config
- [x] Vercel config + security headers
- [x] CI/CD auto-deploy workflow
- [x] Drizzle migrations
- [x] Scheduled tasks
- [x] Agent orchestration
- [x] Outbound webhooks
- [x] Security hardening (helmet, CORS, HMAC)
- [x] App Store metadata
- [x] Deployment guide
- [ ] Run `eas init` → fill `EAS_PROJECT_ID`
- [ ] Fill `APPLE_TEAM_ID` in `eas.json`
- [ ] Add GitHub secrets (FLY_API_TOKEN, VERCEL_TOKEN, etc.)
- [ ] `turso db create 7ei-production` → set DATABASE_URL
- [ ] Create Pinecone index (7ei-knowledge, dim=1536)
- [ ] Create Upstash Redis (eu-central-1)
- [ ] `flyctl deploy` → verify `/health`
- [ ] `vercel --prod` → verify app.7ei.ai
- [ ] EAS production build + App Store submission
