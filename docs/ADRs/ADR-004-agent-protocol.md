# ADR-004 — Agent Protocol

**Date:** 2026-03-20  
**Status:** Accepted

## Context

Agents need to: receive tasks, execute LLM calls (possibly streamed), use skills, hand off to other agents, and report results. Must follow 7Ei_OS protocols.

## Decision

Each agent is a **stateless executor** with a persisted config. The backend holds agent state; the app renders it.

```
Agent Config (DB)
  name, role, personality, llm, skills, org, department

Task Lifecycle
  created → queued → in_progress → done | blocked | failed

Execution
  Backend: receives task → builds system prompt from agent config + skills
        → calls LLM (streaming) → persists output → updates task status
  App: subscribes to task stream via WebSocket
```

Agent-to-agent handoff uses the 7Ei_OS coordination protocol (task YAML format), translated into DB records on the backend.

## Consequences

- Agents are backend constructs; swapping LLM providers requires only a config change
- Streaming supported via WebSockets (Fastify + `ws`)
- Multi-agent orchestration is a backend concern, not a UI concern
- 7Ei_OS memory protocol stored per-agent in DB (long-term.md equivalent as JSON)
