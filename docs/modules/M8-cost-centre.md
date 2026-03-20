# Module M8 — Cost Centre

## Purpose
Track and visualise LLM API spend across the organisation with full granularity.

## Tracked Dimensions
- Per **Organisation**
- Per **Department**
- Per **Agent**
- Per **Project**
- Per **LLM provider** (Claude, OpenAI, Gemini, Grok)

## Cost Record Schema
```
CostRecord
  id
  org_id
  dept_id
  agent_id
  project_id
  task_id
  llm_provider       # claude | openai | gemini | grok | custom
  model              # claude-sonnet-4-6 | gpt-4o | etc.
  input_tokens
  output_tokens
  cost_usd
  created_at
```

## Dashboard
- **Summary cards:** total spend, spend today, spend this month
- **Chart:** spend over time (line graph, toggleable by dimension)
- **Table:** cost breakdown by agent or project
- **Toggle filters:** org / dept / agent / project

## Budget Controls
| Threshold | Action |
|-----------|--------|
| 80% of budget | Warning notification |
| 100% of budget | Hard stop — agent refuses new tasks |
| Monthly reset | Configurable: reset, rollover, or carry forward |

## Budget Assignment
- Set monthly budget at: org level, dept level, agent level
- Child budgets cannot exceed parent budget
- Orchestrator approval to increase budgets

## MVP Scope
- Log cost per task execution
- Basic dashboard (total + per agent)
- Manual budget entry
- 80% / 100% alerts

## Out of Scope (MVP)
- Per-project budget
- Multi-currency
- Invoice export
