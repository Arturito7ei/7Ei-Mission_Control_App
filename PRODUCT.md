# 7Ei Mission Control — Product Definition

> A modular virtual office you run from your phone. AI agents as your team. Your rules.

## Vision

7Ei Mission Control lets any individual or small team operate like a full organisation by giving them an AI-powered virtual office. You define the structure, the agents, the tools, and the integrations. The app ties it all together.

## Core Concept

The fundamental unit is the **Agent** — an AI worker with a name, personality, role, assigned LLM(s), skills, and integrations. Agents are organised into **Departments** within an **Organisation**. Organisations can contain multiple **Projects**.

The default entry point is **Arturito**, the Master Orchestrator / Chief of Staff who bootstraps everything else.

---

## Module Breakdown

### M1 — Organisation & Team Management
- Create and manage **Organisations**, **Departments**, **Teams**, **Projects**
- View in **Grid view** or **Org Chart view**
- Assign agents to departments and projects modularly
- Default org structure: Chief of Staff → Heads of Dev / Marketing / Ops / Finance / R&D + Board of Advisors
- Board of Advisors: modular list of 1–10+ expert personas (real, historical, fictional, or custom)

### M2 — Agent Management
- Create agents with: name, avatar (icon or photo), role, personality profile, CV/Terms of Reference
- Assign one or more LLMs per agent (Claude, GPT, Gemini, Grok, open-source via API key)
- Agent lifecycle: **Active → Idle → Paused → Deleted**
- Agents can be given access to: a phone, another machine, a VM, or a cloud agent runtime
- Agents inherit protocols from 7Ei_OS (Layer 0)

### M3 — Communication Hub
- In-app chat (direct and group)
- Plugin integrations: Google Chat, Google Meet, Gmail, Telegram, WhatsApp
- Per-agent and per-team channels
- Message routing: human → agent, agent → agent, agent → human

### M4 — Knowledge Base
- Hosted options: private server, local machine, or cloud
- Plugin integrations: Google Drive, OneDrive, Dropbox (starting with Google)
- Folder/subfolder structure shared across the org
- Markdown (.md) file support with optional Obsidian sync
- Vector storage integration: Pinecone (for RAG / semantic search)
- Agents read and write to the knowledge base within their permissions

### M5 — Skill Library
- Modular library of agent skills (matching 7Ei_OS skill-system architecture)
- Sync / import skills from GitHub (public skill-library repo)
- Copy and personalise skills per agent or organisation
- Skill domains: Engineering, Operations, Knowledge, Communication, Project Management, Integration

### M6 — Task & Project Management
- In-app lightweight Kanban board (create, assign, move tasks)
- Task automation: plan → assign to agent → execute → verify
- View task execution log live, filtered by agent or status
- Plugin: Jira (read/write to O7MC project space or any Jira instance)

### M7 — Live Task & Output Log
- Real-time stream of tasks being executed by each agent
- Filter by: agent, status (running / completed / blocked / failed), project
- Expandable output view per task
- Audit trail for all agent actions

### M8 — Cost Centre
- Tracks API token usage per: organisation, department, agent, project
- Graphical dashboard with toggle filters
- Budget alerts: 80% warning, 100% hard stop
- Monthly reset with configurable rollover
- Supports all major LLM APIs (Claude, OpenAI, Gemini, Grok)

### M9 — Integrations Hub
- Google Workspace (Drive, Docs, Sheets, Gmail, Calendar, Meet)
- Microsoft 365 (OneDrive, Teams, Outlook) — v2
- Jira / Atlassian
- GitHub
- Telegram / WhatsApp
- Obsidian (via MCP or file sync)
- Pinecone
- Custom API (any LLM via API key)

---

## Platform Targets

| Platform | Priority |
|----------|----------|
| iOS (mobile) | P1 |
| Android (mobile) | P1 |
| Web (desktop view) | P1 |
| Desktop app (Electron/Tauri) | P2 |

---

## User Personas

1. **Solo founder / operator** — running a company of one with a full AI org
2. **Small team (2–10)** — humans + agents working together
3. **Enterprise team** — department-level AI augmentation

---

## Non-Goals (for MVP)

- No real-time audio/video (rely on Google Meet plugin)
- No custom LLM training or fine-tuning
- No Microsoft 365 deep integration (v2)
- No on-premise enterprise deployment
