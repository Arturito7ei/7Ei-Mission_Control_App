# Sprint Status — 7Ei Mission Control App

**Last updated:** 2026-03-20
**Backend:** v0.5.0 · **Mobile:** v0.9.0 · **Web:** v0.1.0

---

## Sprint 0–8 — Complete ✅
Core platform: auth, org/agent/task/project CRUD, Claude streaming, kanban, org chart, skill library, knowledge base, cost centre, comms hub (Gmail/Telegram/Meet), push notifications.

## Sprint 9 — Production Readiness ✅
Jira integration, agent long-term memory, rate limiting, multi-org switcher, EAS build config.

## Sprint 10 — Design System ✅
Full 7Ei token system (dark/light), glassmorphism, color-blind safe status indicators, all components migrated.

## Sprint 11 — Final Production Features ✅

### Multi-Model LLM Router
- `backend/src/services/llm-router.ts` — unified streaming API across providers
- Anthropic (Claude Sonnet 4, Opus 4, Haiku 4.5)
- OpenAI (GPT-4o, GPT-4o Mini) — activate with `OPENAI_API_KEY`
- Google Gemini (2.0 Flash, 1.5 Pro) — activate with `GEMINI_API_KEY`
- `GET /api/models` — list all available models by provider
- Agent create screen: provider picker + model picker per provider
- Agent executor fully provider-agnostic

### Pinecone Vector Search
- `backend/src/services/vector-search.ts` — embeddings (OpenAI text-embedding-3-small) + Pinecone serverless
- Automatic index creation on startup
- Documents indexed on save, deleted on remove
- `GET /api/orgs/:orgId/knowledge/search?q=...` — semantic search
- Knowledge tab: search bar with semantic results + match score %
- Graceful fallback (stub embeddings) when no keys set

### Memory Compression
- Auto-triggers when agent memory exceeds 50 entries
- Compresses to ≤30 entries using Claude Haiku (cheap, fast)
- Preserves oldest timestamps; merges related entries
- Non-blocking (failure = warning, not crash)

### Redis Rate Limiting
- `backend/src/middleware/ratelimit.ts` — Redis client with in-memory fallback
- Set `REDIS_URL=redis://...` to enable distributed limiting
- Usage stats include `backend: 'redis' | 'memory'`
- Async Redis sync (non-blocking, doesn't slow requests)

### Jira Webhooks (inbound real-time)
- `POST /api/jira/webhook/:orgId` — receives issue:created/updated/deleted
- Status sync: Jira status changes update local task status
- `GET /api/orgs/:orgId/jira/events` — last 100 events
- WebSocket live stream: `WS /api/orgs/:orgId/jira/live`
- `GET /api/orgs/:orgId/jira/webhook-url` — setup instructions

### Gmail OAuth on Mobile (PKCE)
- `app/app/gmail/index.tsx` — full Gmail screen
- Expo AuthSession + PKCE code flow
- Redirect URI: `7ei://gmail/callback`
- Scopes: gmail.readonly + gmail.send + openid
- Thread browser + compose + send
- Requires `EXPO_PUBLIC_GOOGLE_CLIENT_ID` in app env

---

## v1.0 Checklist

- [x] All core modules built (0–11)
- [x] Multi-model: Anthropic + OpenAI + Gemini
- [x] Semantic knowledge search (Pinecone)
- [x] Agent memory with auto-compression
- [x] Rate limiting (in-memory + Redis)
- [x] Jira full integration (REST + webhooks + real-time)
- [x] Gmail OAuth on mobile
- [x] Design system (dark + light, color-blind safe)
- [x] EAS build config
- [ ] Fill `EAS_PROJECT_ID` + `APPLE_TEAM_ID` placeholders
- [ ] App Store screenshots + metadata
- [ ] Production Turso DB (replace SQLite)
- [ ] Deploy backend to Fly.io / Railway
- [ ] Connect real Pinecone index
- [ ] Connect Redis (Upstash recommended)

---

## Environment variables — full reference

### Backend
```bash
# Required
CLERK_SECRET_KEY=sk_test_...
ANTHROPIC_API_KEY=sk-ant-...

# Optional — enable extra LLM providers
OPENAI_API_KEY=sk-...          # GPT-4o
GEMINI_API_KEY=AIza...         # Gemini

# Optional — enable semantic search
PINECONE_API_KEY=...
PINECONE_PROJECT_ID=...
PINECONE_ENVIRONMENT=us-east-1-aws

# Optional — enable distributed rate limiting
REDIS_URL=redis://localhost:6379

# Optional — Jira
JIRA_DOMAIN=your-org
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...

# Server
PORT=3001
PUBLIC_URL=https://api.7ei.ai
```

### Mobile
```bash
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
EXPO_PUBLIC_API_URL=http://localhost:3001
EXPO_PUBLIC_GOOGLE_CLIENT_ID=...  # for Gmail OAuth
```

### EAS build
```bash
cd app
eas build --platform ios --profile production
eas submit --platform ios
```
