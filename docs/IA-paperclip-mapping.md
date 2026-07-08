# IA re-fold — Paperclip menu structure ⇄ 7Ei Mission Control (Epic P / P0)

> **Story P0 — "surface what we already have in Paperclip's IA."** We reorganised the web
> dashboard navigation to mirror **Paperclip's** information architecture (`docs/TRD-paperclip.md`
> §3): a **folded, grouped, collapsible sidebar** with the same top-level areas and grouping
> Paperclip uses (`Overview · Workspace · Operate · Delivery · Company · General`). We **re-home**
> our existing surfaces under that structure — we do **not** rebuild features. Paperclip areas we
> don't have yet are added as clearly-labelled **"coming soon"** placeholders pointing at the
> Epic-P gap plan (`docs/GAP-paperclip-config.md`), so the IA reads as complete without faking
> functionality.

## Sidebar groups (Paperclip order)

`Overview → Workspace → Operate → Delivery → Company → General`. Each group is **collapsible**;
collapsed/expanded state persists per browser (`localStorage["mc.nav.collapsed"]`). The whole rail
also **folds to icons** (`localStorage["mc.nav.railFolded"]`).

## Mapping — Paperclip area → our surface

| Group | Paperclip area | Our surface | How it's fulfilled |
|---|---|---|---|
| **Overview** | Dashboard | `Dashboard` (overview tab) | KPI cards + agent squad + notifications |
| Overview | Dashboard / live | `Operations` (Cockpit panel) | the operator stack: inbox, fleet, heartbeat activity, goals, budgets, preflight, secrets, workspaces, plugins, task board — split into first-class areas in **P0b** |
| Overview | Board Chat | `Arturita` (assistant tab) | conversational operator surface (beyond Paperclip) |
| Overview | Search | _placeholder_ | today: **⌘K command palette**; a dedicated search page is the Epic-P gap |
| **Workspace** | Issues / Tasks | `Issues` (tasks tab) | Tasks **↔** Issues — the unit of agent work |
| Workspace | Agents | `Agents` (agents tab + Cockpit fleet) | the hired agent fleet + status |
| Workspace | Projects | `Projects` (projects tab) | codebase/initiative grouping |
| Workspace | Routines | _placeholder_ | backend exists (`routines.ts`, `scheduled_tasks`); no dedicated web surface yet |
| Workspace | Pipelines | _placeholder_ | MISSING (no pipeline/case entity) — Epic-P gap |
| **Operate** | Approvals · Review Queue · RBAC | `Governance` (governance tab) | tri-state approvals + **low-trust review** (P1) + model profiles (P2) |
| Operate | Review Queue | _placeholder_ | quarantine review lives inside Governance today; a dedicated queue page is the gap |
| **Delivery** | Costs | `Costs` (costs tab + Cockpit budgets/preflight) | spend, budgets, preflight cap **↔** Costs |
| Delivery | Skills | `Skills` (skills tab) | skills library (attach depth is a gap) |
| Delivery | Learnings | `Memory` (memory tab) | vault knowledge graph (beyond Paperclip) fills the "Learnings" slot; a distinct Learnings feed is the gap |
| Delivery | Artifacts | _placeholder_ | MISSING (work-product/artifact stacks) — Epic-P gap |
| **Company** | Plugins / Connectors | `Connectors` (connectors tab + Cockpit plugins) | installed integrations |
| Company | Comms | `Comms` (comms tab) | unified inbox / Gmail / Telegram (beyond Paperclip) |
| Company | Adapter registry | _placeholder_ | MISSING (14-adapter registry + probes) — Epic-P gap |
| Company | Members / Access | _placeholder_ | PARTIAL (`org_members`; no per-resource grants ledger) — Epic-P gap |
| **General** | Usage | `Usage` (usage tab) | rate-limit / quota view |
| General | Settings | `Settings` (settings tab) | org description/mission/culture; Company/Instance sub-trees are the gap |

### Beyond Paperclip (kept, re-homed)
`Arturita` (assistant), `Memory` (vault graph), `Comms` are 7Ei-specific surfaces with no Paperclip
analog; they're mounted in the nearest-fit group and clearly ours.

## Slices (one PR each, main green between)

- **P0a — nav shell + mapping (this PR):** folded/grouped/collapsible sidebar from a pure
  `navModel`, the 14 existing tabs re-homed into Paperclip's groups, placeholders for the
  genuinely-missing areas, persistence, tests. Everything previously reachable stays reachable.
- **P0b — re-home Cockpit sections:** promote the Cockpit stack (Inbox, Activity, Goals, Org,
  Approvals, Budgets, Secrets, Workspaces, Plugins) to first-class nav areas via a section filter,
  reusing the existing section components.

## Non-negotiables carried through
Colorblind-safe (icon + label + tone, never color alone), **design tokens only** (no raw hex in new
UI), responsive, Glassmorphism/Arturita styling preserved, collapse state persisted.
