# Iteration Plan — 7Ei Mission Control App

**Methodology:** 2-week sprints. Ship something usable at the end of every sprint.  
**Principle:** Vertical slices — build one full flow end-to-end before adding breadth.

---

## Sprint 0 — Foundation (Week 1–2) 🟡 CURRENT

**Goal:** Repo, architecture, design system, skeleton app running on device.

### Deliverables
- [ ] Confirm tech stack (React Native + Next.js + Node.js/TS backend)
- [ ] Initialise `app/` (React Native / Expo), `web/` (Next.js), `backend/` (Node.js + TS)
- [ ] Design system: colour tokens, typography, spacing (7Ei brand)
- [ ] Navigation skeleton: bottom tab bar (mobile), sidebar (web)
- [ ] Auth flow: Google OAuth login (mobile + web)
- [ ] Basic CI: GitHub Actions lint + build check on PR
- [ ] Architecture Decision Records (ADRs) for: stack, auth, storage, agent protocol
- [ ] PRD published and reviewed

**Definition of Done:** App runs on iOS simulator and Android emulator. Google login works. Tabs navigate.

---

## Sprint 1 — Org Manager + Agent Studio (Week 3–4)

**Goal:** User can create an organisation and spin up their first agent (Arturito).

### Deliverables
- [ ] Org creation flow (name, logo, description)
- [ ] Department + team creation
- [ ] Grid view of org structure
- [ ] Agent creation form (name, avatar, role, personality, LLM assignment)
- [ ] Agent list view with status badges (Idle / Active / Paused)
- [ ] Pre-built Arturito template (Chief of Staff)
- [ ] Claude API integration — agent can respond to a message
- [ ] Basic in-app chat with one agent

**Definition of Done:** User creates org → creates Arturito agent → sends a message → gets a Claude-powered response.

---

## Sprint 2 — Knowledge Base (Week 5–6)

**Goal:** Agents can read from and write to a shared knowledge store.

### Deliverables
- [ ] Google Drive OAuth integration
- [ ] Folder browser (org folders in Drive)
- [ ] Upload / view .md files in-app
- [ ] Share a folder with an agent
- [ ] Agent can reference Drive documents in responses
- [ ] Obsidian vault connection (via MCP) — read notes
- [ ] Knowledge Base tab in app

**Definition of Done:** User connects Google Drive → shares a folder with Arturito → Arturito references doc content in a reply.

---

## Sprint 3 — Task Log + Cost Centre (Week 7–8)

**Goal:** Visibility into what agents are doing and what it costs.

### Deliverables
- [ ] Task object model (id, agent, status, input, output, tokens, duration)
- [ ] Live task feed UI (filterable by agent, status, project, date)
- [ ] Task detail view (full input/output, LLM used, cost)
- [ ] Token + cost tracking per API call
- [ ] Cost Centre dashboard: charts per agent and per project
- [ ] Budget threshold alerts (80% warning, 100% hard stop)
- [ ] Export log as CSV

**Definition of Done:** User assigns Arturito a task → watches it appear in the log → sees token cost in Cost Centre.

---

## Sprint 4 — Project Management (Week 9–10)

**Goal:** Tasks can be planned, assigned to agents, and executed automatically.

### Deliverables
- [ ] Kanban board per project (To Do / In Progress / Done / Blocked)
- [ ] Task creation (title, description, assignee, priority, due date)
- [ ] Assign task to agent → agent auto-executes → posts result
- [ ] Status transitions with audit trail
- [ ] Basic Jira sync (read + update Jira tasks, project key: O7MC)
- [ ] Basic dependency tracking (task blocks task)

**Definition of Done:** User creates a task on the board → assigns to an agent → agent completes it → task moves to Done.

---

## Sprint 5 — Skill Library (Week 11–12)

**Goal:** Agents have skills. Skills are browsable, assignable, and personalised.

### Deliverables
- [ ] Skill Library tab: browse skills from Arturito7ei/skill-library
- [ ] Sync skills from GitHub (pull latest SKILL.md files)
- [ ] Assign skills to agents
- [ ] Fork + personalise a skill (edit in-app)
- [ ] Agent uses assigned skill when relevant

**Definition of Done:** User browses skills → assigns `jira-openclaw` to Arturito → Arturito uses the skill to create a Jira task.

---

## Sprint 6 — Multi-Agent + Silver Board (Week 13–14)

**Goal:** Multiple agents can collaborate. Silver Board is operational.

### Deliverables
- [ ] Add 2+ department head agents (pre-built templates)
- [ ] Agent-to-agent task handoff (via 7Ei_OS coordination protocol)
- [ ] Silver Board: create up to 10 advisor personas
- [ ] Advisor responds in their persona/voice
- [ ] Org chart view (visual hierarchy, interactive)
- [ ] Orchestrator (Arturito) routes tasks to right agent

**Definition of Done:** User sends a strategy question → Arturito routes it to the Silver Board → 3 advisors respond in their distinct voices.

---

## Sprint 7 — Communications Hub (Week 15–16)

**Goal:** All communication in one place.

### Deliverables
- [ ] Unified inbox (all agent conversations)
- [ ] Gmail integration (read + send with human approval)
- [ ] Telegram bot plugin (connect and receive messages)
- [ ] Google Meet link generation from agent
- [ ] Notification routing settings per channel

**Definition of Done:** Agent sends a summary email via Gmail (with user approval). Telegram message arrives in-app.

---

## Sprint 8 — Web Desktop + Polish (Week 17–18)

**Goal:** Web app is production-quality. Mobile is polished.

### Deliverables
- [ ] Web desktop: full feature parity with mobile
- [ ] Sidebar navigation + multi-panel layout
- [ ] Performance audit + optimisation
- [ ] Onboarding flow (first-time user, < 5 minutes)
- [ ] Error handling and empty states throughout
- [ ] App Store + Play Store submission prep

**Definition of Done:** New user completes full onboarding in < 5 minutes on both mobile and web.

---

## Backlog (Post-v1)

- OneDrive / Dropbox knowledge backends
- WhatsApp Business API integration
- Pinecone vector search
- Self-hosted LLM support (Ollama)
- Voice agent interaction
- Virtual machine provisioning (cloud agents)
- Microsoft 365 environment plugin
- Advanced analytics and reporting
- Multi-tenant / team collaboration

---

## Build Principles

1. **Ship vertically** — one full working flow before broadening
2. **Mobile first** — every decision optimises for phone UX first
3. **Modular by design** — every integration is a plugin, never hardcoded
4. **Agent-native** — agents are first-class citizens, not bolted on
5. **Follow 7Ei_OS** — all agent behaviour follows the OS protocols
