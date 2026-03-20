# 7Ei Mission Control — Technical Architecture

## System Overview

```
┌─────────────────────────────────────────────────────┐
│              MOBILE / WEB CLIENT                    │
│         (React Native + Next.js web view)           │
└───────────────────┬─────────────────────────────────┘
                    │ REST / WebSocket
┌───────────────────▼─────────────────────────────────┐
│                 API GATEWAY                         │
│            (Next.js API routes or FastAPI)          │
└──────┬───────────────────────────────┬──────────────┘
       │                               │
┌──────▼──────┐               ┌────────▼────────┐
│  AGENT      │               │  INTEGRATION    │
│  RUNTIME    │               │  LAYER          │
│  SERVICE    │               │  (Google, Jira, │
│             │               │  GitHub, etc.)  │
└──────┬──────┘               └─────────────────┘
       │
┌──────▼──────────────────────────┐
│  LLM ROUTER                     │
│  (Claude / GPT / Gemini / Grok) │
└──────┬──────────────────────────┘
       │
┌──────▼──────┐
│  KNOWLEDGE  │
│  BASE       │
│  (Drive /   │
│  Obsidian / │
│  Pinecone)  │
└─────────────┘
```

## Tech Stack (Recommended)

### Frontend
| Layer | Technology | Rationale |
|-------|-----------|----------|
| Mobile | React Native (Expo) | Single codebase for iOS + Android |
| Web | Next.js 15 (App Router) | Same component logic, SSR |
| State | Zustand | Lightweight, works with RN + Next |
| UI Kit | NativeWind + Shadcn/ui (web) | Tailwind-based consistency |
| Real-time | Socket.io / WebSocket | Live task logs, agent status |

### Backend
| Layer | Technology | Rationale |
|-------|-----------|----------|
| API | Next.js API Routes (MVP) → FastAPI (v2) | Fast start, migrate when needed |
| Auth | Clerk or Supabase Auth | OAuth + social login |
| DB | Supabase (PostgreSQL) | Real-time, hosted, open-source |
| Queue | BullMQ (Redis) | Background agent task execution |
| File Storage | Supabase Storage + Google Drive plugin | |

### AI / Agent Layer
| Component | Technology |
|-----------|----------|
| Agent orchestration | Vercel AI SDK or LangChain.js |
| LLM routing | Per-agent config (model + API key) |
| Vector DB | Pinecone |
| Memory | Files in Google Drive / local (7Ei_OS compatible) |
| Skills | Loaded from skill-library GitHub repo |

### Integrations
| Service | Method |
|---------|-------|
| Google Workspace | Google OAuth + REST APIs |
| Jira / Atlassian | REST API (API token) |
| GitHub | REST + GraphQL API |
| Telegram | Bot API |
| Obsidian | File sync (MCP or Drive plugin) |
| Pinecone | REST API |

## Data Model (Core Entities)

```
Organisation
  └── Departments[]
        └── Teams[]
              └── Agents[]
                    ├── LLM config[]
                    ├── Skills[]
                    ├── Integrations[]
                    └── Memory (7Ei_OS tiered)

Project
  ├── Organisation (owner)
  ├── Tasks[]
  └── KnowledgeBase

Task
  ├── AssignedAgent
  ├── Status (pending / running / done / blocked)
  ├── ExecutionLog[]
  └── CostRecord

CostRecord
  ├── Agent
  ├── LLM
  ├── Tokens (input/output)
  └── USD equivalent
```

## Agent Runtime Architecture

Agents run as background workers (BullMQ jobs):
1. Task created → queued
2. Worker picks up task → calls assigned LLM(s) with context
3. Agent uses skills (bash scripts, API calls, file reads)
4. Output streamed back via WebSocket to client
5. Cost recorded; memory updated per 7Ei_OS protocol

## 7Ei_OS Integration

This app is built around the 7Ei_OS architecture:
- Agents follow the 5-layer knowledge model (L0–L4)
- Memory protocol (4-tier) is implemented in storage layer
- Governance tiers enforced at API level (auto / orchestrator / human)
- Skills loaded from `Arturito7ei/skill-library`

## Security
- All API keys encrypted at rest (Supabase Vault or equivalent)
- No credentials stored client-side
- Agent actions logged with full audit trail
- External comms (email, social) require human approval (Tier 3)
