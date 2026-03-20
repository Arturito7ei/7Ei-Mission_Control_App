# Sprint Status — 7Ei Mission Control App

**Last updated:** 2026-03-20
**Version:** 0.4.0 (backend) / 0.9.0 (mobile)

---

## Sprint 0–8 — Complete ✅
See previous entries. All core modules shipped.

---

## Sprint 9 — Production Readiness ✅

### Jira Integration
- `POST /api/orgs/:orgId/jira/connect` — connect with Atlassian domain + API token
- `GET /api/orgs/:orgId/jira/issues` — list issues (JQL, filters, pagination)
- `POST /api/orgs/:orgId/jira/issues` — create issue (syncs to local tasks)
- `POST /api/orgs/:orgId/jira/sync` — pull open issues → local task queue
- `POST /api/orgs/:orgId/jira/from-task/:taskId` — push completed task → Jira
- Transitions, comments, and update endpoints
- Mobile: full Jira screen (connect / browse / create)
- Web: Jira tab in dashboard
- Default project key: O7MC

### Agent Long-Term Memory
- Memory stored in `agents.memory_long_term` (JSON, persisted to DB)
- Auto-extracted from agent output: `[REMEMBER: key = value]` tags
- Memory injected into every system prompt
- CRUD API: get / set / bulk-set / delete / clear per agent
- Mobile: Memory screen with entry list, add form, delete, clear all
- Memory count badge on agent detail tab
- Agent executor: strips memory tags from visible output

### Rate Limiting & Usage Caps
- Sliding window: requests per minute per org
- Daily budget: tokens/day + cost/day per org
- Concurrent task slots per org
- All limits configurable via env vars
- `GET /api/orgs/:orgId/usage` — current stats
- Mobile: Usage screen with progress bars + limit info
- Web: Usage tab in dashboard

### Multi-Org Switcher
- `GET /api/orgs/switch/list` — enriched org list (agent count, active, pending)
- `POST /api/agents/:agentId/transfer` — move agent to another org
- `POST /api/agents/:agentId/clone` — copy agent to another org
- `POST /api/orgs/:orgId/duplicate` — deep-copy org (org + depts + agents)
- Mobile: Org switcher screen with stats, duplicate, settings links
- Home screen: org name tappable to open switcher (↕ indicator)

### EAS Build Configuration
- `app/eas.json` — development / preview / production profiles
- `app/app.json` — v0.9.0, bundle ID `ai.7ei.missioncontrol`, push notif config
- iOS + Android configured for App Store / Play Store submission

---

## Remaining for v1.0 production

- [ ] `EAS_PROJECT_ID` and `APPLE_TEAM_ID` placeholders need real values
- [ ] App Store screenshots and metadata
- [ ] Pinecone vector search for knowledge base (Sprint 10)
- [ ] Gmail OAuth flow on mobile (full PKCE flow via Expo AuthSession)
- [ ] Agent memory compression (summarise when > 50 entries)
- [ ] Redis-backed rate limiting (replace in-memory store)
- [ ] Multi-model support: OpenAI GPT-4o, Gemini (stub exists in schema)
- [ ] Jira webhook (inbound real-time issue updates)

---

## Setup (Sprint 9 additions)

```bash
# Add to backend/.env
RATE_LIMIT_RPM=60
RATE_LIMIT_TOKENS_DAY=500000
RATE_LIMIT_COST_DAY=5.0
RATE_LIMIT_CONCURRENT=5

# Jira connection (optional — can also set per-org via POST /api/orgs/:id/jira/connect)
JIRA_DOMAIN=your-org
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=xxx
JIRA_DEFAULT_PROJECT=O7MC
```

### EAS build
```bash
cd app
npm install -g eas-cli
eas login
eas build --platform ios --profile development    # dev build
eas build --platform all --profile production      # App Store
eas submit --platform ios --profile production     # submit
```
