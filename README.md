# 7Ei Mission Control App

A modular virtual office in your pocket. Spin up an AI organisation with a Chief of Staff agent and grow it modularly — adding departments, tools, integrations, and cloud agents as needed.

## Stack

| Layer | Technology |
|-------|----------|
| Mobile | React Native + Expo SDK 51 |
| Web | Next.js 15 (App Router) |
| Backend | Node.js + TypeScript + Fastify |
| Database | SQLite (dev) / Turso (prod) |
| Auth | Clerk (Google OAuth) |
| LLM | Anthropic Claude (streaming via WebSocket) |
| Monorepo | npm workspaces |

## Modules

| Module | Status |
|--------|--------|
| Org Manager (create org, departments, grid view) | ✅ |
| Agent Studio (create/configure/chat with agents) | ✅ |
| Agent Templates (Arturito, Dept heads, Silver Board) | ✅ |
| Org Chart (visual hierarchy) | ✅ |
| Task Log (live feed, filters, cost details) | ✅ |
| Cost Centre (charts by agent / day / period) | ✅ |
| Kanban Board (per project, 4 columns) | ✅ |
| Skill Library (browse, sync from GitHub, assign) | ✅ |
| Knowledge Base (Google Drive integration) | ✅ (structure) |
| Web Dashboard (sidebar, agents, tasks, costs) | ✅ |
| Communications Hub (Telegram, Gmail) | 🔲 Sprint 7 |

## Quick Start

See `docs/SPRINT-STATUS.md` for detailed setup instructions.

```bash
# Backend
cd backend && cp .env.example .env  # add your keys
npm install && npm run dev

# Mobile
cd app && cp .env.example .env.local  # add Clerk key
npm install && npx expo start

# Web
cd web && cp .env.example .env.local  # add Clerk keys
npm install && npm run dev
```

## Org
- **GitHub:** [Arturito7ei](https://github.com/Arturito7ei)
- **OS:** Follows [7Ei_OS](https://github.com/Arturito7ei/7Ei_OS) protocols
- **Owner:** arturito@7ei.ai
