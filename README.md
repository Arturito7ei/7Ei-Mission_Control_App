# 7Ei Mission Control

> Your modular virtual office, powered by AI agents. Built in Zürich.

[![Deploy Backend](https://img.shields.io/badge/backend-Fly.io-6366f1?logo=fly)](https://7ei-backend.fly.dev/health)
[![Deploy Web](https://img.shields.io/badge/web-Vercel-black?logo=vercel)](https://app.7ei.ai)
[![EAS Build](https://img.shields.io/badge/mobile-EAS%20Build-4630eb?logo=expo)](https://expo.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is 7Ei?

Spin up a full AI organisation from your phone. Start with Arturito — your Chief of Staff — then add department heads (Dev, Marketing, Finance, Ops, R&D) and a Silver Board of advisors. Every agent streams responses in real-time.

**Features**
- Multi-model: Claude (Anthropic), GPT-4o (OpenAI), Gemini (Google) — per agent
- Agent orchestration: Arturito delegates tasks to specialists automatically
- Long-term memory: agents remember context across conversations
- Scheduled tasks: run agents on a cron (daily briefings, weekly reports)
- Jira integration: bidirectional sync + real-time webhooks
- Semantic knowledge search: Google Drive × Pinecone
- Outbound webhooks: agents can call Slack, Zapier, and any external API
- Cost tracking: every token and dollar visible in real-time
- Dark + light mode, color-blind safe design

---

## Quick Start (local dev)

```bash
# 1. Clone
git clone https://github.com/Arturito7ei/7Ei-Mission_Control_App
cd 7Ei-Mission_Control_App

# 2. Backend
cd backend && cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, CLERK_SECRET_KEY
npm install && npm run dev
# → http://localhost:3001/health

# 3. Mobile
cd app && cp .env.example .env.local
# Fill in: EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
npm install && npx expo start

# 4. Web
cd web && cp .env.example .env.local
npm install && npm run dev
# → http://localhost:3000
```

---

## Production Deployment

### One-command setup
```bash
bash scripts/setup-prod.sh
```

This script walks you through all 10 go-live tasks interactively:
1. EAS Project ID
2. Apple Team ID
3. Turso DB (Frankfurt)
4. Pinecone index
5. Upstash Redis (eu-central-1)
6. Fly.io backend deploy
7. Vercel web deploy
8. GitHub CI secrets
9. EAS production build
10. App Store / Play Store submission

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full manual guide.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile | React Native + Expo SDK 51 |
| Web | Next.js 15 App Router |
| Backend | Node.js + Fastify + TypeScript |
| Database | SQLite (dev) / Turso (prod) + Drizzle ORM |
| Auth | Clerk (Google OAuth + magic link) |
| LLM | Anthropic Claude, OpenAI GPT-4o, Google Gemini |
| Vector Search | Pinecone serverless |
| Rate Limiting | In-memory + Upstash Redis |
| Deploy | Fly.io (backend) + Vercel (web) + EAS (mobile) |

---

## Architecture

```
Mobile (iOS/Android)  ─┬────────────────────────┬─ Fly.io Frankfurt
                       │                        │
Web (Vercel fra1)  ──┴─ Fastify API + WS  ───┤
                              │      │      │    │
                         Turso DB  Pinecone  Redis  Jira
```

---

## Agents

| Agent | Role | Default Model |
|-------|------|---------------|
| Arturito | Chief of Staff + Orchestrator | Claude Sonnet 4 |
| Dev | Head of Development | any |
| Maya | Head of Marketing | any |
| Ops | Head of Operations | any |
| CFO | Chief Financial Officer | any |
| R&D | Head of Research | any |
| Silver Board | Advisor personas | any |

---

## Scripts

```bash
bash scripts/setup-prod.sh      # Full production setup
bash scripts/check-secrets.sh   # Verify all Fly.io secrets
bash scripts/submit-stores.sh   # Submit to App Store + Google Play
bash scripts/add-custom-domain.sh  # api.7ei.ai + app.7ei.ai DNS
```

---

## Documentation

- [`docs/DEPLOY.md`](docs/DEPLOY.md) — step-by-step deployment guide
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — 7Ei token system
- [`docs/APP_STORE.md`](docs/APP_STORE.md) — App Store metadata + screenshots
- [`docs/SPRINT-STATUS.md`](docs/SPRINT-STATUS.md) — full feature list

---

## License

MIT © 2026 7Ei — Made in Zürich
