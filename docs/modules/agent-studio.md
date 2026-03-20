# Module: Agent Studio

## Purpose

The interface for creating, configuring, and managing AI agents within a 7Ei organisation.

## Core Entities

### Agent

```typescript
interface Agent {
  id: string
  name: string
  avatar: string            // URL to image or icon identifier
  role: string              // e.g. "Chief of Staff", "Head of Marketing"
  personality: string       // Free text — defines voice and style
  cvProfile: string         // Markdown — background and expertise
  termsOfReference: string  // Markdown — mandate and limits
  llmAssignments: LLMAssignment[]
  skills: string[]          // Skill IDs from skill library
  orgId: string
  departmentId?: string
  status: 'idle' | 'active' | 'paused' | 'stopped'
  createdAt: Date
  updatedAt: Date
}

interface LLMAssignment {
  provider: 'anthropic' | 'openai' | 'google' | 'xai' | 'custom'
  model: string             // e.g. 'claude-sonnet-4-20250514'
  apiKeyRef: string         // Reference to stored key — never in plaintext
  isPrimary: boolean
  usageScope?: string       // e.g. 'planning' | 'execution' | 'all'
}
```

## Pre-Built Templates

| Template ID | Name | Role | Default LLM |
|-------------|------|------|-------------|
| `arturito-chief` | Arturito | Chief of Staff, Master Orchestrator | Claude Opus |
| `head-dev` | Dev Lead | Head of Development | Claude Sonnet |
| `head-marketing` | Mktg Lead | Head of Marketing | Claude Sonnet |
| `head-ops` | Ops Lead | Head of Operations | Claude Sonnet |
| `head-finance` | CFO | Head of Finance | Claude Sonnet |
| `head-rd` | R&D Lead | Head of R&D | Claude Opus |
| `advisor-board` | Silver Advisor | Board Advisor | Claude Opus |

## Silver Board Pattern

Advisors are agents with a specific persona:
- Can be real people (living or historical), fictional characters, or domain archetypes
- Examples: Warren Buffett (investing), Sun Tzu (strategy), a fictional "Senior VP Product at Apple"
- Each advisor has a distinct voice defined in their `personality` field
- Arturito routes strategy questions to the board and synthesises responses

## Key Flows

### Create Agent
1. User taps "+ New Agent"
2. Selects template or starts blank
3. Fills: name, avatar, role, personality
4. Optionally attaches: CV/profile, terms of reference
5. Assigns LLM(s) — enters API key or selects existing stored key
6. Assigns to department
7. Saves → agent is created in `idle` status

### Activate Agent
1. User selects agent → taps "Activate"
2. Agent status changes to `active`
3. Agent begins accepting tasks and messages

### Pause / Stop / Delete
- **Pause** — agent stops accepting new tasks; resumes from where it left off
- **Stop** — agent completes current task then goes offline
- **Delete** — requires confirmation; archives memory before removal
