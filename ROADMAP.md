# 7Ei Mission Control — Roadmap

## Iteration Philosophy

Build the thinnest useful slice at each phase. Every phase ships something real. No big-bang releases.

---

## Phase 0 — Foundation (NOW)
**Goal:** Repo, product definition, architecture, and project structure in place.

- [x] Elevator pitch captured and structured
- [x] `PRODUCT.md` — full feature spec
- [x] `ARCHITECTURE.md` — technical stack
- [x] `ROADMAP.md` — iteration plan
- [x] GitHub repo scaffolded (`7Ei-Mission_Control_App`)
- [x] Google Drive project folder linked
- [ ] Module specs written (`docs/modules/`)
- [ ] ADR-001: Frontend framework decision
- [ ] ADR-002: Backend framework decision
- [ ] ADR-003: LLM routing strategy

**Deliverable:** Full project definition committed. Ready to build.

---

## Phase 1 — MVP Shell (Mobile + Web, ~4 weeks)
**Goal:** A working app shell with one agent (Arturito) you can talk to and assign tasks.

### M1 — Org & Agent Management (basic)
- [ ] Create organisation
- [ ] Create agent (name, role, avatar, LLM config)
- [ ] Org chart view (simple tree)
- [ ] Agent status (idle / active / paused)

### M2 — Chat (basic)
- [ ] In-app chat with a single agent
- [ ] Message history
- [ ] Agent responds via assigned LLM API

### M6 — Tasks (basic)
- [ ] Create task, assign to agent
- [ ] Simple status: pending → running → done
- [ ] Manual execution trigger

### M7 — Live Log (basic)
- [ ] Stream agent output to a log view
- [ ] Filter by agent

### Infrastructure
- [ ] Auth (Clerk or Supabase)
- [ ] DB schema (Supabase)
- [ ] LLM router (Claude + OpenAI to start)
- [ ] React Native (Expo) + Next.js web shell

**Deliverable:** You can open the app, create Arturito, assign him a task, and watch him execute it.

---

## Phase 2 — Org + Knowledge (~3 weeks)
**Goal:** Multi-agent org with a connected knowledge base.

- [ ] M1: Multi-department org with multiple agents
- [ ] M1: Board of Advisors module
- [ ] M4: Google Drive integration (read/write)
- [ ] M4: .md file support
- [ ] M5: Skill library browser + assign skills to agents
- [ ] M8: Basic cost tracking (tokens per agent)

**Deliverable:** A full virtual org with Arturito + 3–5 specialist agents, all connected to Google Drive.

---

## Phase 3 — Communication + Task Automation (~3 weeks)
**Goal:** Agents communicate and execute tasks autonomously.

- [ ] M3: Telegram plugin
- [ ] M3: Gmail integration (read; send with human approval)
- [ ] M6: Kanban board
- [ ] M6: Jira plugin (read/write)
- [ ] M6: Task automation (agent → agent handoff)
- [ ] M7: Full execution log with output expandable per task

**Deliverable:** Arturito can receive a brief via Telegram, decompose it into Jira tasks, assign to specialist agents, and execute.

---

## Phase 4 — Cost Centre + Advanced Knowledge (~2 weeks)
**Goal:** Full observability and semantic knowledge.

- [ ] M8: Full cost dashboard (org / dept / agent / project toggles)
- [ ] M8: Budget alerts and hard stops
- [ ] M4: Pinecone integration (vector search)
- [ ] M4: Obsidian sync (MCP or file)
- [ ] M9: Integrations Hub UI (connect/disconnect services)

**Deliverable:** Full cost visibility. Semantic search across org knowledge. Obsidian vault live.

---

## Phase 5 — Scale + Polish (~ongoing)
**Goal:** Multi-machine agents, VM spawning, Microsoft 365, desktop app.

- [ ] Agent on remote machine / VM (cloud runtime)
- [ ] Microsoft 365 integration (OneDrive, Teams, Outlook)
- [ ] Desktop app (Tauri or Electron)
- [ ] Agent marketplace (import community agents)
- [ ] Public skill library contributions

---

## Decisions Needed Before Phase 1 Starts

| Decision | Options | Owner |
|----------|---------|-------|
| Frontend framework | Expo (RN) + Next.js vs Flutter + Next.js | Human |
| Backend | Next.js API Routes vs FastAPI | Human |
| Auth provider | Clerk vs Supabase Auth | Human |
| First LLM | Claude only vs Claude + OpenAI | Human |
| Hosting | Vercel + Supabase vs self-hosted | Human |
