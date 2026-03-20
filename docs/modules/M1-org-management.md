# Module M1 — Organisation & Team Management

## Purpose
Allow users to create and navigate a structured virtual organisation of humans and AI agents.

## Views

### Grid View
- Card-based layout of all departments and agents
- Quick status indicators per agent (active / idle / paused)
- Tap to open agent detail

### Org Chart View
- Tree structure: Organisation → Departments → Agents
- Drag-and-drop to reorganise (v2)
- Colour-coded by department

## Default Org Structure
```
Organisation
└── Chief of Staff (Arturito — Master Orchestrator)
    ├── Head of Development
    ├── Head of Marketing
    ├── Head of Operations
    ├── Head of Finance
    ├── Head of R&D
    └── Board of Advisors (1–10 expert personas)
```

## Board of Advisors
- A modular list of expert agent personas
- Each advisor has: name, expertise domain, personality, source (e.g. "Inspired by Peter Drucker")
- Can be real people, historical figures, fictional, or fully custom
- Consulted by Arturito for strategic decisions

## Data Model
```
Organisation
  id, name, logo, owner_user_id, created_at

Department
  id, org_id, name, icon, head_agent_id

Agent
  id, org_id, dept_id, name, avatar, role, status
  personality, cv, terms_of_reference
  llm_configs[], skill_ids[], integration_ids[]
```

## MVP Scope
- Create org (name + logo)
- Create departments
- Create agents with name, role, avatar, LLM assignment
- Org chart view (read-only tree)
- Grid view

## Out of Scope (MVP)
- Drag-and-drop reorganisation
- Department-level budgets
- Multi-org switching
