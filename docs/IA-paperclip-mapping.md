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

## The rail after P1 (current)

P1 shortened the rail. **No surface was deleted** — every one of them is still routable (⌘K palette
+ any deep link to its id still renders it). A surface now lives in exactly one of three places, and
`navModel` enforces that partition (`allSurfaces() = rail ∪ hosted tabs ∪ off-rail`):

| Group | Rail item | Tabs it hosts |
|---|---|---|
| **Overview** | Dashboard · 🎙️ Command Center · Operations · **Inbox / Comms** · Activity | Inbox / Comms → `Inbox` \| `Comms` |
| **Workspace** | Agents · Projects · Org · Routines _(soon)_ | — |
| **Operate** | Governance · Review Queue _(soon)_ | — |
| **Delivery** | **Costs** · Skills · Memory | Costs → `Costs` \| `Budgets` |
| **Company** | **Connectors** · Members & Access _(soon)_ | Connectors → `Connectors` \| `Plugins` |
| **General** | Usage · **Settings** | Settings → `Settings` \| `Adapters` \| `Secrets` |

**Off the rail, still routable** (`HIDDEN_ITEMS` — reachable via ⌘K, code untouched):
`Search`, `Issues`, `Goals`, `Pipelines`, `Workspaces`, `Artifacts`.

Selecting a hosted tab keeps its **parent** lit in the rail (`navSelectedId`), so the rail never
"loses" the user inside a tabbed page.

## Mapping — Paperclip area → our surface

> The `Our surface` column below records the **original** re-home (P0a/P0b). Where P1 moved a surface
> into a tab bar or off the rail, the P1 table above is the authority on **where it appears**; the
> surface itself is unchanged.

| Group | Paperclip area | Our surface | How it's fulfilled |
|---|---|---|---|
| **Overview** | Dashboard | `Dashboard` (overview tab) · **live** | KPI cards + agent squad + notifications |
| Overview | Dashboard / live | `Operations` (Cockpit panel) | the full operator stack (fleet · voice · task board + every promoted section below) |
| Overview | Inbox | `Inbox` **(live, P0b)** | promoted Cockpit `InboxSection` — items needing attention + inline approvals |
| Overview | Activity | `Activity` **(live, P0b)** | promoted Cockpit `TimelineSection` — heartbeat / last-24h feed |
| Overview | Board Chat | `Arturita` (assistant tab) | conversational operator surface (beyond Paperclip) |
| Overview | Search | _placeholder_ | today: **⌘K command palette**; a dedicated search page is the Epic-P gap |
| **Workspace** | Issues / Tasks | `Issues` (tasks tab) | Tasks **↔** Issues — the unit of agent work |
| Workspace | Agents | `Agents` (agents tab + Cockpit fleet) | the hired agent fleet + status |
| Workspace | Projects | `Projects` (projects tab) | codebase/initiative grouping |
| Workspace | Goals | `Goals` **(live, P0b)** | promoted Cockpit `GoalsSection` — strategic goals tree |
| Workspace | Org | `Org` **(live, P0b)** | promoted Cockpit `OrgChart` — reports-to hierarchy |
| Workspace | Routines | _placeholder_ | backend exists (`routines.ts`, `scheduled_tasks`); no dedicated web surface yet |
| Workspace | Pipelines | _placeholder_ | MISSING (no pipeline/case entity) — Epic-P gap |
| **Operate** | Approvals · Review Queue · RBAC | `Governance` (governance tab) | tri-state approvals + **low-trust review** (P1) + model profiles (P2) |
| Operate | Workspaces | `Workspaces` **(live, P0b)** | promoted Cockpit `WorkspacesSection` — execution workspaces |
| Operate | Review Queue | _placeholder_ | quarantine review lives inside Governance today; a dedicated queue page is the gap |
| **Delivery** | Costs | `Costs` (costs tab) | spend / cost-centre view |
| Delivery | Budgets / Preflight | `Budgets` **(live, P0b)** | promoted Cockpit `BudgetsSection` + `PreflightSection` — caps & per-wake preflight |
| Delivery | Skills | `Skills` (skills tab) | skills library (attach depth is a gap) |
| Delivery | Learnings | `Memory` (memory tab) | vault knowledge graph (beyond Paperclip) fills the "Learnings" slot; a distinct Learnings feed is the gap |
| Delivery | Artifacts | _placeholder_ | MISSING (work-product/artifact stacks) — Epic-P gap |
| **Company** | Plugins / Connectors | `Connectors` (connectors tab) · `Plugins` **(live, P0b)** | installed integrations (`Plugins` = promoted Cockpit `PluginsSection`) |
| Company | Secrets | `Secrets` **(live, P0b)** | promoted Cockpit `SecretsSection` — encrypted store + bindings |
| Company | Comms | `Comms` (comms tab) | unified inbox / Gmail / Telegram (beyond Paperclip) |
| Company | Adapter registry | _placeholder_ | MISSING (14-adapter registry + probes) — Epic-P gap |
| Company | Members / Access | _placeholder_ | PARTIAL (`org_members`; no per-resource grants ledger) — Epic-P gap |
| **General** | Usage | `Usage` (usage tab) | rate-limit / quota view |
| General | Settings | `Settings` (settings tab) | org description/mission/culture; Company/Instance sub-trees are the gap |

> **Approvals** stay reachable via **Inbox** (inline tri-state) and **Governance** (config + low-trust
> review); a dedicated Approvals page wasn't split out to avoid duplicating the same queue.

### Beyond Paperclip (kept, re-homed)
`Arturita` (assistant), `Memory` (vault graph), `Comms` are 7Ei-specific surfaces with no Paperclip
analog; they're mounted in the nearest-fit group and clearly ours.

## Slices (one PR each, main green between)

- **P0a — nav shell + mapping (this PR):** folded/grouped/collapsible sidebar from a pure
  `navModel`, the 14 existing tabs re-homed into Paperclip's groups, placeholders for the
  genuinely-missing areas, persistence, tests. Everything previously reachable stays reachable.
- **P0b — re-home Cockpit sections (shipped):** promoted the Cockpit stack (Inbox, Activity, Goals,
  Org, Budgets, Secrets, Workspaces, Plugins) to first-class nav areas via a `CockpitPanel` `only`
  section filter — the same composition root renders either the full **Operations** stack or a single
  focused area, reusing every existing section component (no rebuild). Approvals stay in Inbox +
  Governance (see note above).
- **P1 — shorten the rail (shipped):** P0b made every surface first-class, which made the rail long.
  P1 folds five surfaces into their parent's **tab bar** (`Budgets`→Costs, `Plugins`→Connectors,
  `Comms`→Inbox _(now "Inbox / Comms")_, `Adapters` + `Secrets`→Settings) via a new `PageTabs.tsx`
  driven by `navPageTabs()`, and takes six off the rail entirely (`Search`, `Issues`, `Goals`,
  `Pipelines`, `Workspaces`, `Artifacts` → `HIDDEN_ITEMS`). **Nothing was deleted and nothing became
  unreachable** — the palette walks `allSurfaces()`, and the nav tests assert the removals, each fold
  target, and the "every prior surface still reachable" invariant.

## Non-negotiables carried through
Colorblind-safe (icon + label + tone, never color alone), **design tokens only** (no raw hex in new
UI), responsive, Glassmorphism/Arturita styling preserved, collapse state persisted.
