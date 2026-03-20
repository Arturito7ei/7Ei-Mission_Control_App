# 7Ei Mission Control App — Technical Architecture

## Stack Decision (v1)

| Layer | Technology | Rationale |
|-------|-----------|----------|
| Mobile | React Native + Expo | Single codebase for iOS + Android |
| Web/Desktop | Next.js (same component library) | Shared UI components with mobile |
| UI Components | NativeWind (Tailwind) or Tamagui | Cross-platform styling — decide in Phase 1 |
| Backend API | Next.js API Routes | Start simple, extract if needed |
| Auth | Supabase Auth | OAuth, email, RLS integration |
| Database | Supabase (PostgreSQL) | Managed, real-time subscriptions, storage built-in |
| Real-time | Supabase Realtime | Live task log, agent status updates |
| LLM Gateway | Anthropic, OpenAI, Google APIs | Direct API calls per agent config |
| Vector DB | Pinecone | Knowledge base semantic search |
| Storage | Google Drive API (v1) | Knowledge base file sync |
| Notifications | Expo Push Notifications | Mobile alerts |

---

## System Diagram

```
┌──────────────────────────────────────────────────────┐
│                   CLIENT LAYER                       │
│  React Native (iOS/Android)  +  Next.js (Web)        │
└──────────────────────┬───────────────────────────────┘
                       │ REST / WebSocket
┌──────────────────────▼───────────────────────────────┐
│                    API LAYER                         │
│  Next.js API Routes                                  │
│  Auth (Supabase)                                     │
└──────┬─────────┬──────────┬──────────┬───────────────┘
       │         │          │          │
┌──────▼───┐ ┌───▼───┐ ┌────▼────┐ ┌──▼──────────────────┐
│  DB      │ │Realtime│ │  LLM   │ │  Integrations        │
│Supabase  │ │Subs    │ │Gateway  │ │  Google Drive        │
│PostgreSQL│ │        │ │Claude   │ │  Telegram / Gmail    │
│          │ │        │ │GPT      │ │  Jira / GitHub       │
│          │ │        │ │Gemini   │ │  Pinecone            │
└──────────┘ └───────┘ └─────────┘ └──────────────────────┘
```

---

## Data Model (Core Entities)

```
Organisation
  └── has many Departments
  └── has many Projects
  └── has many Agents

Agent
  └── belongs to Organisation + Department
  └── has Identity (name, avatar, personality, CV, ToR)
  └── has LLM Config (model, API key, parameters)
  └── has Status (idle | active | paused | stopped)
  └── has many Skills
  └── has many Tasks

Task
  └── belongs to Agent + Project
  └── has Status (queued | running | done | blocked | failed)
  └── has Execution Log (live output stream)

KnowledgeBase
  └── belongs to Organisation
  └── has many Sources (GoogleDrive | LocalFile | Obsidian | Pinecone)

CostRecord
  └── belongs to Organisation / Department / Agent / Project
  └── has LLM usage data (tokens, cost, model, timestamp)
```

---

## Agent Runtime Environments

| Environment | How It Works |
|-------------|-------------|
| Cloud (default) | Agent runs as a managed process on the app's backend |
| Phone | Agent runs via React Native process with limited capabilities |
| Physical machine | Agent connects via SSH or MCP server on the target machine |
| VM / Cloud instance | Agent connects to a provisioned VM via API or MCP |

---

## Security Model

- API keys stored encrypted in Supabase Vault (never in client)
- Row-Level Security (RLS) on all DB tables — users only see their org's data
- Agent actions governed by 7Ei_OS governance tiers (auto / orchestrator / human)
- All external integrations use OAuth 2.0 where available
- No credentials stored in Git

---

## Knowledge Layer Mapping

The app enforces the 7Ei_OS 5-layer knowledge model:

| App Concept | Knowledge Layer |
|-------------|----------------|
| 7Ei_OS protocols | L0 (OS) |
| Organisation settings, integrations | L1 (Org) |
| Agent identity, personality, CV | L2 (Agent) |
| Project files in Knowledge Base | L3 (Project) |
| Live task logs, current session | L4 (Session) |
