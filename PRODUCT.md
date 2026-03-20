# 7Ei Mission Control — Product Definition

## Vision

A modular virtual office platform that lets anyone build and operate an AI-powered organisation — starting from a single phone, scaling to a full cloud infrastructure with multiple agents, departments, and integrations.

## Target Users

- Solo founders and entrepreneurs who want AI leverage without an engineering team
- Small teams augmenting human capacity with specialised AI agents
- 7Ei itself — the primary dogfooding client

## Core Concept

The fundamental unit is an **Agent**. Agents are AI workers with names, avatars, personalities, CVs, terms of reference, and assigned LLMs. They operate inside **Organisations**, grouped into **Departments**, and assigned to **Projects**.

The default first agent is **Arturito** — Chief of Staff and master orchestrator. From Arturito, the rest of the org grows modularly.

---

## Modules

### M1 — Organisation Management

Create and manage the structure of your virtual office.

**Features:**
- Create organisations, departments, and teams
- Org chart view (hierarchical, interactive)
- Grid view (card-based, scannable)
- Modular department types: Development, Marketing, Operations, Finance, R&D, Legal, and custom
- Board of Advisors module: curate a panel of up to 10+ advisors (real, historical, fictional, or composite personas) whose consolidated knowledge the agent draws on

---

### M2 — Agent Management

Create and manage individual AI agents.

**Features:**
- Name, avatar (icon or photo), role, and department assignment
- Personality definition (communication style, decision approach, risk tolerance)
- CV / Profile (background, expertise, experience)
- Terms of Reference (scope of authority, limitations)
- LLM assignment: one or many models per agent (Claude, GPT, Gemini, Grok, others) via API key
- Agent status: Idle / Active / Paused / Stopped
- Create, pause/stop, and delete agents
- Runtime environments: phone, physical machine, VM, cloud instance

---

### M3 — Communication Hub

All communication in one place.

**Features:**
- In-app chat (human ↔ agent, agent ↔ agent)
- Integration plugins:
  - Google Chat and Google Meet
  - Gmail
  - Telegram (private rooms)
  - WhatsApp
  - Microsoft Teams (v2+)
- Notifications: task updates, agent alerts, cost warnings

---

### M4 — Knowledge Base

Organisational memory and document management.

**Features:**
- Private server hosting (self-hosted option)
- Cloud integrations (start with Google Drive; add OneDrive, Dropbox modularly)
- Physical machine / local hard drive option
- Folder and subfolder structure shared across agents and humans
- .md file support — direct share and sync with Obsidian
- Vector database integration: Pinecone (and others)
- GitHub plugin: sync skill libraries and markdown documents
- All knowledge maps to the 5-layer model defined in 7Ei_OS

---

### M5 — Task and Execution Centre

See what agents are doing, live.

**Features:**
- Live task log: what each agent is executing right now
- Filter by agent, status (queued / running / done / blocked / failed)
- Task outputs visible inline
- Execution history and audit trail
- Task assignment: human assigns to agent, or agent auto-assigns based on role

---

### M6 — Cost Centre

Track and control AI spend.

**Features:**
- API usage data collected per LLM call
- Graphical dashboard: line, bar, and pie charts
- Toggle views: per organisation / department / agent / project
- Budget thresholds: warning at 80%, hard stop at 100%
- Monthly reset with configurable rollover
- Export as CSV or Google Sheet

---

### M7 — Skill Library

Capabilities agents can load and use.

**Features:**
- Browse the shared skill library (from `Arturito7ei/skill-library`)
- Sync / import skills via GitHub plugin
- Copy skill to local and personalise
- Assign skills to specific agents
- Create new skills and contribute back via PR
- Skill domains: Engineering, Operations, Knowledge, Communication, Project Management, Integration

---

### M8 — Task Management (Kanban + Automation)

Simple in-app planning with optional Jira integration.

**Features:**
- Kanban board: To Do / In Progress / Blocked / Done
- Task cards: title, description, assignee (agent or human), priority, due date
- Automation: define triggers (e.g., "when task moves to Done, notify via Telegram")
- Jira plugin: bidirectional sync with `7ei.atlassian.net` O7MC project
- Sprint planning view

---

## Platform Availability

| Platform | Version | Notes |
|----------|---------|-------|
| iOS | v1 | Primary mobile target |
| Android | v1 | Primary mobile target |
| Web (desktop) | v1 | Full feature parity |

---

## Integration Map

| Category | Integrations (v1) | Planned (v2+) |
|----------|-------------------|---------------|
| LLMs | Claude, GPT, Gemini, Grok | Open-source models, local inference |
| Storage | Google Drive | OneDrive, Dropbox, local disk |
| Communication | Telegram, Gmail, Google Chat | WhatsApp, Teams |
| Tasks | In-app Kanban, Jira | Asana, Linear |
| Knowledge | Obsidian (.md), Pinecone | Notion, Confluence |
| Code | GitHub | GitLab, Bitbucket |
| Compute | Cloud VMs | Physical machines, Raspberry Pi |
| Productivity | Google Workspace | Microsoft 365 |

---

## Design Principles

1. **Modular by default** — every feature is a plugin that can be added or removed
2. **Phone-first** — full power from a mobile device, no desktop required to start
3. **Agent-native** — built to serve agents as first-class users, not just humans
4. **Privacy-respecting** — self-hosted options for all data-sensitive modules
5. **OS-aligned** — all agent behaviour follows 7Ei_OS protocols
