# 7Ei Mission Control App — Iteration Roadmap

## Strategy: Dogfood-First

We build the app to run 7Ei itself. Every feature is proven on our own organisation before being shipped. This keeps scope tight and quality high.

---

## Phase 0 — Foundation ✅
*Goal: Define the product before touching code.*

- [x] Elevator pitch structured into product spec (`PRODUCT.md`)
- [x] Technical architecture defined (`ARCHITECTURE.md`)
- [x] Iteration roadmap created (`ROADMAP.md`)
- [x] GitHub repo bootstrapped
- [x] Google Drive project folder linked
- [x] ADR-001: Tech stack decision documented
- [x] Alignment with 7Ei_OS protocols documented in `CLAUDE.md`

---

## Phase 1 — Skeleton (MVP Shell)
*Goal: A running app that renders the core structure. No real AI yet.*

**Deliverables:**
- [ ] React Native + Expo project scaffolded
- [ ] Next.js web project scaffolded (shared component approach)
- [ ] Auth: login / signup with Supabase
- [ ] Data model: Organisation, Department, Agent entities in Supabase
- [ ] UI: Org chart view (basic, static)
- [ ] UI: Agent list view with status badges
- [ ] UI: Create Agent form (name, role, department, avatar)
- [ ] CI: GitHub Actions for lint + test on every PR

**Exit criteria:** A logged-in user can create an organisation, add departments, and create an Arturito agent — viewable on mobile and web.

---

## Phase 2 — Live Agent (First AI Response)
*Goal: One agent, one LLM, one conversation.*

**Deliverables:**
- [ ] LLM gateway: call Claude (or GPT) with agent identity injected into system prompt
- [ ] In-app chat: human → agent → response
- [ ] Agent personality and CV reflected in system prompt
- [ ] Task log: record each LLM call as a task entry
- [ ] Cost tracking: log token usage per call

**Exit criteria:** A user can chat with Arturito, whose responses reflect the personality and role defined in the app.

---

## Phase 3 — Multi-Agent Org
*Goal: Arturito spawns and manages a team.*

**Deliverables:**
- [ ] Spawn agent flow: Arturito can create a subordinate agent via UI or chat command
- [ ] Agent-to-agent task handoff (via task queue)
- [ ] Department structure: agents grouped by department
- [ ] Org chart view: interactive, shows agent status live
- [ ] Board of Advisors module: define advisor personas
- [ ] Agent pause/stop/delete lifecycle

**Exit criteria:** Arturito exists alongside at least 3 department heads. Tasks can be routed between them.

---

## Phase 4 — Knowledge Base
*Goal: Agents can read and write to a shared knowledge base.*

**Deliverables:**
- [ ] Google Drive integration: connect org Drive folder
- [ ] Folder/subfolder browser in app
- [ ] Agent can read files from Drive and reference them in responses
- [ ] .md file sync: Obsidian vault read access
- [ ] Basic Pinecone integration: embed and query documents

**Exit criteria:** An agent asked about a document stored in Drive can answer accurately from its content.

---

## Phase 5 — Task Management + Automation
*Goal: Plan work and watch agents execute it.*

**Deliverables:**
- [ ] In-app Kanban board (To Do / In Progress / Blocked / Done)
- [ ] Task creation and assignment to agents
- [ ] Live execution log with real-time output streaming
- [ ] Basic automation: trigger action on task status change
- [ ] Jira plugin: bidirectional sync with O7MC project

**Exit criteria:** A task created in the app is executed by the assigned agent; progress is visible live in the task log.

---

## Phase 6 — Skill Library
*Goal: Agents can load and use shared skills.*

**Deliverables:**
- [ ] Skill library browser (from `Arturito7ei/skill-library`)
- [ ] GitHub sync: pull skill updates from repo
- [ ] Assign skills to agents
- [ ] Skill execution: agent invokes a skill during task
- [ ] Contribute skill: create a new skill from the app and open a GitHub PR

**Exit criteria:** Arturito can load the `jira-openclaw` skill and create a Jira task via the skill.

---

## Phase 7 — Cost Centre + Admin
*Goal: Full visibility and control over spend and access.*

**Deliverables:**
- [ ] Cost dashboard: charts by org / dept / agent / project
- [ ] Budget thresholds and alerts
- [ ] Monthly reset with rollover config
- [ ] CSV and Google Sheet export
- [ ] Admin panel: manage members, permissions, integrations

**Exit criteria:** A user can see the monthly AI spend broken down by agent and set a budget cap.

---

## Phase 8 — Communication Hub
*Goal: Agents communicate across channels.*

**Deliverables:**
- [ ] Telegram integration: agent sends and receives via Telegram
- [ ] Gmail integration: agent can draft and (with human approval) send emails
- [ ] Google Meet: schedule and join meeting from app
- [ ] Notification centre: task updates, cost warnings, agent alerts

---

## Beyond v1

- WhatsApp integration
- Microsoft 365 environment (Teams, OneDrive, Outlook)
- Local machine / Raspberry Pi agent runtime
- Open-source LLM support (Ollama, local inference)
- Multi-org / white-label mode
- App Store + Play Store release

---

## Principles for Building

1. **One phase at a time** — never skip. Each phase exit criteria must be met before starting the next.
2. **Dogfood continuously** — 7Ei runs on this app from Phase 2 onwards.
3. **Modular from day one** — integrations are plugins, not hard dependencies.
4. **7Ei_OS first** — all agent behaviour follows the protocols in `7Ei_OS`.
