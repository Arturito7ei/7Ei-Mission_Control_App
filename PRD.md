# Product Requirements Document
# 7Ei Mission Control App

**Version:** 0.1  
**Date:** 2026-03-20  
**Owner:** arturito@7ei.ai  
**Status:** Draft

---

## 1. Vision

A modular virtual office in your pocket. Anyone — solo founder, small team, enterprise — can spin up an AI-powered organisation with a Chief of Staff agent and grow it modularly: adding departments, tools, integrations, and cloud machines as needed.

## 2. Users

| User Type | Description |
|-----------|-------------|
| Solo founder | Runs their whole company through one phone, using agents as a virtual team |
| Small team (2–10) | Adds human + AI members; uses Mission Control as ops hub |
| Enterprise (future) | Deploys Mission Control as internal AI orchestration layer |

## 3. Platforms

- **Primary:** iOS + Android mobile app (React Native / Expo)
- **Secondary:** Web desktop (Next.js) — mirrors mobile, adds power-user views

## 4. Module Specifications

### 4.1 Organisation Manager

**Purpose:** Create and navigate the structure of your virtual organisation.

**Requirements:**
- Create organisations with name, logo, description
- Create departments/teams within an organisation
- Create projects assigned to teams
- Two navigation views:
  - **Grid view** — card-based, scan quickly
  - **Org chart view** — visual hierarchy, drag-and-drop
- Export org chart as PNG/PDF
- Invite human members (email invite)

### 4.2 Agent Studio

**Purpose:** Define, configure, and operate AI agents.

**Requirements:**
- Create agent with: name, avatar (icon or photo), role/title
- Define agent personality (text field + optional template presets)
- Attach CV/profile and terms of reference documents
- Assign one or more LLMs per agent (Claude, GPT, Gemini, Grok, others via API key)
- Assign skill set from skill library
- Assign agent to org + department + projects
- Set agent status: Idle / Active / Paused / Stopped
- Pause, resume, or delete agents
- Pre-built agent templates:
  - Chief of Staff (Arturito)
  - Head of Development
  - Head of Marketing
  - Head of Operations
  - Head of Finance
  - Head of R&D
  - Silver Board Advisor (expert persona)
- **Silver Board:** Up to 10+ advisors, each with a persona (real, historical, fictional, or domain expert — living, dead, or imaginary)

### 4.3 Communications Hub

**Purpose:** Centralise all communication channels in one inbox.

**Requirements:**
- In-app chat (agent ↔ human, agent ↔ agent)
- Channel integrations (modular, pluggable):
  - Google Chat
  - Google Meet (schedule + launch)
  - Email (Gmail integration)
  - Telegram (private rooms / bot)
  - WhatsApp (via WhatsApp Business API — v2)
- Notification routing: surface agent messages in preferred channel
- Message history per agent and per project

### 4.4 Knowledge Base

**Purpose:** Shared organisational memory — files, docs, vectors.

**Requirements:**
- Storage backends (modular, user-selects at setup):
  - Google Drive (primary v1)
  - OneDrive (v2)
  - Dropbox (v2)
  - Local machine / physical drive (v2)
  - Private server (v2)
- Folder/subfolder structure per org and project
- Share folders with agents
- Markdown (.md) file support — view, edit, share
- Obsidian vault integration (via MCP)
- Vector search with Pinecone (for semantic agent queries — v2)
- Import/export documents

### 4.5 Task & Execution Log

**Purpose:** Real-time visibility into what agents are doing.

**Requirements:**
- Live feed of tasks being executed
- Filter by: agent, status (pending / in_progress / done / blocked), project, date
- Task detail view: full input, output, LLM used, tokens consumed, duration, cost
- Error / blocked task alerts
- Export log as CSV or JSON

### 4.6 Cost Centre

**Purpose:** Track and visualise API and compute costs.

**Requirements:**
- Aggregate API usage data (per LLM provider)
- Breakdown views: per organisation / department / agent / project
- Time range toggles (daily / weekly / monthly)
- Budget thresholds with alerts (80% warning, 100% hard stop)
- Visual: bar charts, trend lines
- Export as CSV

### 4.7 Skill Library

**Purpose:** Give agents modular, reusable capabilities.

**Requirements:**
- Browse available skills from shared skill library (GitHub: Arturito7ei/skill-library)
- Sync / import latest skills from GitHub
- Copy and personalise a skill (fork to org's private copy)
- Edit skill instructions in-app
- Assign skills to specific agents
- Skill domains: Engineering, Operations, Knowledge, Communication, Project Management, Integration

### 4.8 Project Management

**Purpose:** Plan and execute work — human and agent tasks together.

**Requirements:**
- Kanban board per project (To Do / In Progress / Done / Blocked)
- Create tasks: title, description, assignee (human or agent), priority, due date
- Automate task execution: assign task to agent → agent executes → reports result
- Jira plugin: sync tasks bidirectionally (project key: O7MC)
- Basic dependency tracking (task blocks task)
- Sprint / milestone grouping

## 5. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Mobile performance | < 2s load for main screens |
| Agent response latency | < 5s for most agent queries |
| Offline capability | Read-only mode when offline |
| Security | OAuth 2.0 auth; no credentials in client code |
| Privacy | User data stays in chosen storage backend |
| Extensibility | All major components are pluggable modules |

## 6. Out of Scope (v1)

- Native desktop apps (macOS, Windows)
- Self-hosted LLMs
- Real-time voice agent interaction
- Financial transaction capabilities
- Multi-tenant SaaS billing

## 7. Success Metrics

- User can create an org with 3 agents in < 5 minutes
- Agent completes an assigned task end-to-end without human intervention
- Cost Centre accurately reflects API usage within 15-minute delay
- Skill sync from GitHub completes in < 30 seconds
