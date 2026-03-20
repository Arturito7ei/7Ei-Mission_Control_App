# Module M2 — Agent Management

## Purpose
Define, configure, and manage individual AI agent instances.

## Agent Profile Components

| Field | Description | Required |
|-------|-------------|----------|
| Name | Display name | Yes |
| Avatar | Icon, emoji, or photo | Yes |
| Role | Job title in the org | Yes |
| Personality | Communication style, decision approach | Yes |
| CV / Profile | Background, expertise, experience | Optional |
| Terms of Reference | What this agent is authorised to do | Optional |
| LLM(s) | One or more: Claude, GPT, Gemini, Grok, custom | Yes |
| Skills | Selected from skill library | Optional |
| Integrations | Google, Jira, GitHub, etc. | Optional |
| Runtime | In-app / phone / machine / VM / cloud | Yes |

## LLM Assignment
- Each agent can be assigned multiple LLMs
- Primary LLM used by default; fallbacks configurable
- API key stored encrypted per agent
- Model version selectable (e.g. claude-sonnet-4-6, gpt-4o)

## Agent Lifecycle
```
Created → Active ↔ Idle → Paused → Deleted
```
- **Active:** Currently executing a task
- **Idle:** Online, waiting for tasks
- **Paused:** Suspended, not accepting tasks
- **Deleted:** Soft-deleted, archivable

## Runtime Options
| Runtime | Description |
|---------|-------------|
| In-app | Runs within the Mission Control app process |
| Remote phone | Assigned to another device |
| Remote machine | Assigned to a laptop/desktop via agent daemon |
| Cloud VM | Runs on a cloud virtual machine |
| Cloud agent | Fully managed cloud agent (e.g. Claude Code remote) |

## MVP Scope
- Create agent with name, avatar, role, personality
- Assign single LLM + API key
- Agent status display
- Basic in-app runtime only

## Out of Scope (MVP)
- Remote machine / VM runtimes
- Multi-LLM per agent
- CV and Terms of Reference editor
