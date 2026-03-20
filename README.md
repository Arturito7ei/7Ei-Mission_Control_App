# 7Ei Mission Control App

A modular virtual office — orchestrated by AI agents, managed from your phone.

## What This Is

7Ei Mission Control is a mobile-first (iOS + Android) application that lets you spin up and operate a complete virtual organisation from your phone. You start with one AI agent (Arturito, Chief of Staff) and grow modularly — adding departments, agents, tools, knowledge bases, and cloud infrastructure as you need them.

A web desktop view mirrors the mobile experience for power users.

## Core Concept

```
You (Human)
  └── Arturito (Chief of Staff / Master Orchestrator)
        ├── Head of Development
        ├── Head of Marketing
        ├── Head of Operations
        ├── Head of Finance
        ├── Head of R&D
        ├── Silver Board of Advisors (10+ expert personas)
        └── [Any custom department — modular]
```

Each agent can be assigned:
- A name and avatar
- A personality, CV/profile, and terms of reference
- One or many LLMs (Claude, GPT, Gemini, Grok, others) via API
- A specific skill set from the shared skill library
- Access to tools and integrations

## Key Modules

| Module | Description |
|--------|-------------|
| **Org Manager** | Create orgs, projects, teams. Grid and org chart views. |
| **Agent Studio** | Create, configure, pause, and delete agents. Assign LLMs and skills. |
| **Communications Hub** | In-app chat, Google Chat/Meet, email, Telegram, WhatsApp plugins. |
| **Knowledge Base** | Google Drive, OneDrive, Dropbox, Obsidian, Pinecone — modular. |
| **Task & Execution Log** | Live task feed, filter by agent and status. |
| **Cost Centre** | API usage dashboard — per org, department, agent, or project. |
| **Skill Library** | Browse, sync, and personalise skills from GitHub. |
| **Project Management** | Kanban boards + Jira plugin. |

## Repository Structure

```
7Ei-Mission_Control_App/
├── README.md                  # This file
├── PRD.md                     # Product Requirements Document
├── ITERATION_PLAN.md          # Sprint-by-sprint build plan
├── docs/
│   ├── architecture/          # System design, ADRs
│   ├── modules/               # Per-module specs
│   └── integrations/          # Third-party integration docs
├── app/                       # React Native app source
├── web/                       # Next.js web desktop source
├── backend/                   # API + agent runtime backend
└── skills/                    # Skill library (git submodule → skill-library)
```

## Tech Stack (Proposed — Confirmed in Sprint 0)

| Layer | Technology |
|-------|------------|
| Mobile | React Native (iOS + Android) |
| Web Desktop | Next.js |
| Backend/API | Node.js + TypeScript |
| Agent Runtime | Claude API (primary), modular LLM adapters |
| Database | SQLite (local) + Supabase (cloud) |
| Knowledge | Google Drive API, Obsidian MCP, Pinecone |
| Auth | Google OAuth |
| CI/CD | GitHub Actions + Vercel |

## Operating System

All agents follow protocols from [7Ei_OS](https://github.com/Arturito7ei/7Ei_OS).

## Status

🟡 **Sprint 0 — Foundation** (current)

See `ITERATION_PLAN.md` for the full roadmap.
