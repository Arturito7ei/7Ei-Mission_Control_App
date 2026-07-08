# TRD — Paperclip (reverse-engineered technical requirements)

> **What this is.** A technical-requirements paper reconstructing the *entire* Paperclip application — an AI‑agent control plane ("cockpit") — from its running local instance. Every top‑level tab, sub‑page, feature area, data entity, and the full HTTP API surface are documented, then cross‑checked three ways.
> **Instance read.** `version 2026.626.0`, `deploymentMode: local_trusted`, `deploymentExposure: private`, running at `http://127.0.0.1:3100` (loopback).
> **Date:** 2026‑07‑08 · **Owner:** operator (arturito@7ei.ai) · **Method:** read‑only. *Nothing in Paperclip was modified.*
> **Companion:** `docs/GAP-paperclip-config.md` (the earlier, narrower scrape of just the agent‑configuration page). This paper supersedes it in breadth; §11 keeps the parity/gap view as an appendix.

---

## 0. How Paperclip was read (reproducible, three‑way cross‑check)

Paperclip is a **client‑rendered Vite/React SPA**: `curl` of `/` returns only a `<div id="root">` shell plus `<script type="module" src="/assets/index-Du79WqkB.js">` and `/assets/index-j0_DVW3H.css`. **No auth was required** — `GET /api/health` reports `deploymentMode:"local_trusted"` and `deploymentExposure:"private"`, and the session resolves to a built‑in implicit board identity (`GET /api/auth/get-session` → `session.id="paperclip:local_implicit:local-board"`, `user.email="local@paperclip.local"`, `name="Board"`). So every JSON endpoint is reachable from host loopback without a cookie.

The surface was reconstructed and cross‑checked three ways:

1. **Live JSON API** — enumerated the reachable control‑plane endpoints (health, companies, agents, adapters, projects, issues, goals, members/grants, environments, secrets, budgets, costs, dashboard, activity, heartbeat‑runs, execution‑workspaces, search, instance settings, per‑adapter model catalogs, adapter config‑schemas, …). Every call used `curl --max-time`; nothing was launched in the background.
2. **SPA bundle** (`/assets/index-Du79WqkB.js`, ~4.85 MB minified) — extracted the **full client route map** (React‑Router `path:` definitions), the navigation/tab structure, ~250 distinct `/api/...` path templates, form field labels + hint text, enums, and feature flags (all survive minification as string literals). CSS (`index-j0_DVW3H.css`, ~377 KB) yielded the design‑token system.
3. **Registries** — the adapter registry (`GET /api/adapters`, 14 built‑ins with capability flags + model counts), per‑adapter model catalogs, per‑adapter environment capabilities, and adapter config‑schemas.

**Confidence / completeness note.** The route map, nav, API table, design tokens, adapters, feature flags, and every entity shape below are **exact reads** of the running instance. The one area reconstructed *primarily* from live entity payloads + bundle string literals (rather than an exhaustive minified‑source sweep) is the **enum/field catalog** in §8 — it is near‑complete and every value shown is evidenced, but treat it as "observed" rather than "provably exhaustive." No section is blocked; nothing is guessed without being labelled as an inference.

---

## 1. Overview & architecture

Paperclip is a **multi‑company, single‑instance control plane for fleets of AI coding agents**. Human operators ("the Board") hire agents, assign them work (issues/tasks organised under projects and goals), and supervise execution through approvals, budgets, watchdogs, and a low‑trust review queue. Agents run through pluggable **adapters** (Claude Code, Codex, Cursor, Gemini CLI, Grok, OpenCode, ACPX, gateways…) inside **execution workspaces** on configurable **environments**.

### 1.1 Technology stack (observed)

| Layer | Technology (evidence) |
|---|---|
| Frontend | **Vite**‑built **React** SPA; **React Router** (client routing via `path:` route table); **Tailwind CSS v4** (`--tw-*`, `--spacing-*`) + **shadcn/ui** semantic layer + **Radix UI** primitives (Dialog, Popover, Tooltip, Tabs, DropdownMenu, ScrollArea, Collapsible…) and Radix color scales. Rich editors: **MDXEditor** (markdown), **CodeMirror** + **Sandpack** (code), **Mermaid** (diagrams). Class‑based dark/light theming with `paperclip.theme` in `localStorage`. |
| Backend | JSON HTTP API under `/api`, company‑scoped under `/api/companies/:companyId/...`; **WebSocket** realtime (`/api/companies/:companyId/events/ws`) and **SSE** streams (plugin bridges, run event streams). Server reports `serverInfo.git.available`, backup‑retention policy, and version string `2026.626.0`. |
| Persistence | Server‑managed instance data rooted at `~/.paperclip/instances/default/...` (agent instruction bundles, project managed checkouts, run logs as `.ndjson` files with SHA‑256 + byte length). Run logs stored `local_file` with `logStore/logRef/logSha256/logBytes/logCompressed`. |
| Auth | **better‑auth**‑style endpoints (`/api/auth/sign-in/email`, `/api/auth/sign-up/email`, `/api/auth/get-session`, `/api/auth/profile`); in `local_trusted` mode an **implicit local board** identity is auto‑granted owner. CLI device‑auth (`/api/cli-auth/...`) and board‑claim/invite tokens for onboarding. |
| Agent runtimes | External **BYO‑agent adapters** (local CLIs and gateways) — the server orchestrates processes (PID/process‑group tracked), sessions, and instruction/skill materialisation. |

### 1.2 High‑level architecture — "three planes"

- **Control plane** (this app / API): companies, agents, config, governance, budgets, RBAC.
- **Work plane**: goals → projects → issues/tasks → runs, with execution workspaces and environments.
- **Runtime plane**: adapters spawn agent processes; heartbeat/scheduler drives autonomous wakes; watchdogs + recovery keep runs healthy; costs/finance meter usage.

### 1.3 Scoping model

- **Instance** (super‑admin / "Instance settings"): global defaults, adapters, environments, heartbeats, plugins, experimental flags, instance‑admin user management, backup retention.
- **Company** (tenant): everything is nested under `/api/companies/:companyId/...`. A company has an `issuePrefix` (e.g. `EIA`) used to form human issue identifiers (`EIA-3`) and in URL slugs. The instance observed hosts 4 companies (2 active `7Ei` variants, 2 archived `TARCO` variants).
- **User → company membership** with a `membershipRole` (`owner`, …) and a **grants ledger** (fine‑grained `permissionKey` + optional `scope`).

---

## 2. Deployment modes, trust & exposure (non‑functional, surfaced by the app)

`GET /api/health` exposes the running posture:

```json
{"status":"ok","version":"2026.626.0","deploymentMode":"local_trusted",
 "deploymentExposure":"private","authReady":true,"bootstrapStatus":"ready",
 "bootstrapInviteActive":false,"features":{"companyDeletionEnabled":true},
 "serverInfo":{"processStartedAt":"…","git":{"available":false,"unavailableReason":"git_unavailable"}}}
```

| Concept | Observed value | Meaning / other values implied by the bundle |
|---|---|---|
| `deploymentMode` | `local_trusted` | Local single‑operator trusted mode → implicit board identity, no login wall. Other modes implied by auth/cloud plumbing: hosted/cloud (full auth), and a bootstrap/invite path (`bootstrapStatus`, `bootstrapInviteActive`, board‑claim tokens). |
| `deploymentExposure` | `private` | Bound to loopback / private network. A non‑private exposure would gate the API behind auth. |
| Bootstrap | `bootstrapStatus:"ready"` | First‑run bootstrap + optional invite (`/onboarding`, `/invite/:token`, `/board-claim/:token`). |
| Instance admin | promote/demote endpoints | Instance‑level admin is a distinct privilege from company owner. |
| Backups | `general.backupRetention` `{dailyDays:7, weeklyWeeks:4, monthlyMonths:1}` | Built‑in backup retention policy. |
| Log privacy | `general.censorUsernameInLogs` | Optional username censoring in logs. |

**Trust levels appear at two layers:** (a) instance/deployment posture above, and (b) **per‑agent trust mode** (`standard` vs `low_trust_review`) with a bounded resource set and a quarantine review queue (§5.14). Skills carry a **`trustLevel`** (`scripts_executables`, …) and a `compatibility` flag.

---

## 3. Information architecture — full navigation map

### 3.1 Primary (left) navigation

Grouped sidebar (group headers observed: **Overview · Workspace · Operate · Delivery · Company · General**). Collapsible, with per‑user ordering (`sidebar-preferences/me`) and live badge counts (`sidebar-badges` → `{inbox, approvals, failedRuns, joinRequests}`). A company switcher sits above it (multi‑company); an **Instance** scope is separate.

| Nav item | Route(s) | Purpose |
|---|---|---|
| **Dashboard** | `/dashboard`, `/dashboard/live` | KPI overview + a live‑runs mode |
| **Inbox** | `/inbox` (`/mine`, `/requests`, `/blocked`, `/new`, `/recent`, `/unread`, `/all`) | Operator work queue: items needing attention, requests, unread |
| **Issues** | `/issues` (`/active`, `/backlog`, `/done`, `/recent`, `/all`, `/:issueId`) | Tasks / work items (the unit of agent work) |
| **Agents** | `/agents` (`/active`, `/paused`, `/error`, `/all`, `/new`, `/:agentId`, `/:agentId/:tab`, `/:agentId/runs/:runId`) | The hired AI agents + their detail/config |
| **Projects** | `/projects` (`/:projectId` + tabs) | Codebases/initiatives grouping issues |
| **Routines** | `/routines` (`/:routineId`, `/:routineId/:section`) | Recurring scheduled tasks + triggers |
| **Pipelines** | `/pipelines` (`/:pipelineId` + stages/cases/settings) | Multi‑stage case pipelines (feature‑flagged) |
| **Approvals** | `/approvals` (`/pending`, `/all`, `/:approvalId`) | Human‑in‑the‑loop approval gate |
| **Review Queue** | `/review-queue`, cases `/cases/:id/review` | Low‑trust quarantine review |
| **Goals** | `/goals` (`/:goalId`) | Company/strategic goals that projects roll up to |
| **Costs** | `/costs` | Spend / budget / finance analytics |
| **Skills** | `/skills/*` (catalog/available) | Agent skills library |
| **Plugins** | `/plugins` (`/:pluginId`) | Connectors / integrations |
| **Org** | `/org` | Org chart of agents (reports‑to hierarchy) |
| **Activity** | `/activity` | Company activity feed |
| **Learnings** | `/learnings` | Captured learnings |
| **Artifacts** | `/artifacts` | Work‑product / artifact stacks |
| **Search** | `/search` | Global search (issues, comments, docs, identifiers) |
| **Board Chat** | `/board-chat` | Conference/board chat (`/api/board/chat/stream`) |
| **Workspaces** | `/workspaces`, `/execution-workspaces/:id` | Execution workspaces + runtime logs/services |
| **Settings** | `/company/settings/*`, `/instance/settings/*` | Company + instance configuration (§3.3) |

Secondary utility routes: `/onboarding`, `/invite/:token`, `/board-claim/:token`, `/cli-auth/:id`, `/u/:userSlug` (user profile), `/design-guide`, `/needs_attention`, `/costs`, plus a `/:companyPrefix` company‑root and a `/:pluginRoutePath/*` mount for plugin‑contributed pages.

### 3.2 Per‑page tab sets

| Page | Tabs (route/`?tab=`) |
|---|---|
| **Agent detail** `/agents/:id` | **Instructions · Skills · Configuration · Runs · Budget · Dashboard** (`/agents/:id/{skills,runs,dashboard}`) |
| **Project detail** `/projects/:id` | **Overview · Issues · Workspaces · Budget · Configuration** |
| **Routine detail** `/routines/:id` | **Overview · Triggers · Revisions · Runs · Description** (`?tab=triggers`, `?tab=runs`) |
| **Pipeline detail** `/pipelines/:id` | **Cases · Stages · Settings · Health · Transitions · Intake form** (`settings?stage=…&section=instructions`) |
| **Issue detail** `/issues/:id` | **Activity · Comments · Approvals · Runs · Attachments · External objects · Work products · Sub‑tasks** |
| **Execution workspace** `/execution-workspaces/:id` | **Configuration · Issues · Routines · Runtime logs · Services** |
| **Plugin detail** `/plugins/:id` | **Dashboard · Config · Health · Logs** |
| **Secret detail** `/secrets/:id` | **Usage · Access events · Rotate** |

### 3.3 Settings — Company vs Instance

**Company settings** (`/company/settings/*`): **General · Access · Members · Invites · Permissions · Secrets · Environments · Cloud‑upstream**.

**Instance settings** (`/company/settings/instance/*` and `/instance/settings/*`, instance‑admin only): **General · Profile · Access · Adapters · Environments · Heartbeats · Plugins · Experimental**. Live payload (`GET /api/instance/settings`) confirms `general{censorUsernameInLogs, keyboardShortcuts, feedbackDataSharingPreference, backupRetention{dailyDays, weeklyWeeks, monthlyMonths}}` and an `experimental` block (see §3.4).

### 3.4 Feature flags (instance `experimental`, live values)

| Flag | Observed | Gates |
|---|---|---|
| `enableEnvironments` | false | First‑class Environments entity/UI |
| `enableIsolatedWorkspaces` | false | git‑worktree / isolated execution workspaces |
| `enableStreamlinedLeftNavigation` | true | Newer left‑nav layout |
| `enablePipelines` | false | Pipelines subsystem |
| `enableConferenceRoomChat` | false | Board/conference chat |
| `enableIssuePlanDecompositions` | false | Plan‑decomposition of issues |
| `enableExperimentalFileViewer` | false | Experimental file viewer |
| `enableTaskWatchdogs` | false | Task‑level watchdogs |
| `enableCloudSync` | false | Cloud upstream sync |
| `enableExternalObjects` | false | External‑object linking (Jira/GitHub‑style) |
| `enableServerInfoDebugView` | false | Server‑info debug view |
| `autoRestartDevServerWhenIdle` | false | Auto‑restart idle dev server |
| `enableIssueGraphLivenessAutoRecovery` | false | Issue‑graph liveness auto‑recovery |
| `issueGraphLivenessAutoRecoveryLookbackHours` | 24 | Lookback window for the above |

Additional company‑level toggles: `companyDeletionEnabled` (health `features`), `requireBoardApprovalForNewAgents`, `feedbackDataSharingEnabled/Preference`.

---

## 4. Component & UX inventory

### 4.1 Component library (evidenced from bundle/CSS)

Dialog / AlertDialog, Drawer / Sheet, Popover, Tooltip, Toast, Tabs, Badge (status pills), Table (with horizontal scroll), Card (with density), Select / Combobox / **Command palette (⌘K)**, DropdownMenu / Menubar, Checkbox / Switch / Toggle / ToggleGroup, Progress + ProgressSummary, ScrollArea / Resizable / Separator / Collapsible, Avatar (upload/remove), Breadcrumbs, **Chart** (`--chart-1..5`), **Kanban board** (task columns), **Org chart**, **Timeline / activity feed**, **Markdown editor** (MDXEditor), **Mermaid renderer**, **Code editor** (CodeMirror + Sandpack), **File tree / virtual‑file editor**, **Diff / revision‑compare viewer**, **key‑value editor** (env vars / headers), **mention chips** (agent/project), **terminal / shell** (runtime commands & services), search‑match highlight chips, shimmer/skeleton loaders.

### 4.2 States (verbatim strings)

- **Empty:** "No agents attached yet.", "No approvals yet." / "No pending approvals.", "No goals yet.", "No pipelines yet.", "No configuration revisions yet.", "No models discovered." / "No model detected. Select or enter one manually.", "No matching secrets. Create one to bind it here.", "No organizational hierarchy defined.", "No active or recent agent runs.", "No cost data yet.", "No new inbox items.".
- **Loading:** "Loading companies…", "Loading adapters…", "Loading configuration…", "Loading join requests…", "Loading run log" / "Loading more run log", "Loading scheduler heartbeats…", "Checking assigned tasks…".
- **Error:** uniform "Failed to <verb> …" pattern (~120 distinct), e.g. "Failed to create agent", "Failed to rotate webhook secret", "Failed to install plugin", "Failed to reset session", "Failed to render Mermaid diagram."; generic fallback "Try again".

### 4.3 Key action verbs

Create · Save · Edit · Rename · Delete · Archive · Restore · Import · Export · Refresh · Preview · Scan · Run / Run now · Pause · Resume · Retry · Reset · Terminate · **Wake / Wake on demand** · Approve · Reject · **Request revision** · Resubmit · **Send for review** · Acknowledge (drift) · Invite · Revoke · **Detect model** · **Test environment** · Connect · Test connection · Install · Reinstall · Enable · Disable · Reload · Upgrade · Sync · **Rotate** · **Rollback / Restore** (config revision).

### 4.4 Design tokens (from `index-j0_DVW3H.css`)

- **System:** Tailwind v4 + shadcn/ui + Radix. Class‑based `.dark`/`.light` on root; both themes fully defined; theme persisted in `localStorage["paperclip.theme"]`, `<meta theme-color>` swapped (`#18181b` dark / `#ffffff` light).
- **Palette — neutral/zinc, monochrome by design.** Core semantic colors are pure‑neutral OKLCH (chroma 0 = grayscale); **red is the only chromatic accent** (`--destructive`). E.g. dark `--background: oklch(14.5% 0 0)`, `--card: oklch(20.5% 0 0)`, `--border: oklch(26.9% 0 0)`, `--primary: oklch(98.5% 0 0)`; `--destructive: oklch(57.7% .245 27.325)`.
- **Status tokens (hex):** agents — running `#2563eb`, idle `#a8aeb2`, paused `#f59e0b`, error `#dc2626`; tasks — done `#22c55e`, todo `#f59e0b`, blocked `#dc2626`, backlog/cancelled `#a8aeb2`.
- **Agent identity palette:** 10 named agents × 2 shades (`--agent-1a..10b`) to color‑code agents across org/board views.
- **Chart:** `--chart-1..5`; search‑match chips `--chip-match-{title,comment,document,identifier}-{bg,border,fg}`; doc annotations `--paperclip-doc-annotation-highlight-{focused,open,resolved,stale}`.
- **Typography:** `--font-sans` (ui‑sans‑serif/system‑ui), `--font-mono` (ui‑monospace/SF Mono/Menlo), `--font-body` (system‑ui). Weights normal→bold.
- **Shape:** `--radius: 0` by default → **flat, squared, monochrome aesthetic** (a full `--radius-xs…2xl` scale exists but the base is square corners). 4px spacing grid (`--spacing`), shimmer/skeleton tokens, standard `spin/pulse/ping/bounce` animations.

---

## 5. Per‑area functional requirements

Each area lists purpose, key features/fields/states, and the backing API (methods/paths in §7). Company‑scoped paths abbreviate `/api/companies/:companyId` as `…`.

### 5.1 Dashboard
- **Purpose:** operator overview. `GET …/dashboard` → `{agents{active,running,paused,error}, tasks{open,inProgress,blocked,done}, costs{monthSpendCents,monthBudgetCents,monthUtilizationPercent}, pendingApprovals, budgets{activeIncidents,pendingApprovals,pausedAgents,pausedProjects}, runActivity[{date,succeeded,failed,other,total}]}`.
- Cards: Active Agents, Open Issues, Tasks In Progress, Pending Approvals, Recent Runs, Live runs, Active incidents, Month Spend, Review queue/outcomes. `/dashboard/live` streams live runs.

### 5.2 Inbox
- Operator queue of items needing attention. Filters: mine / requests / blocked / new / recent / unread / all. Dismiss via `POST …/inbox-dismissals`; issue‑level `POST /issues/:id/inbox-archive`, `POST /issues/:id/read`. Badge count from `sidebar-badges.inbox`.

### 5.3 Issues / Tasks (the unit of work)
- **Purpose:** trackable work items assigned to an agent (or user), grouped by project and goal, with a human identifier (`EIA-3`).
- **Fields (live):** `title, description, status, workMode, priority, assigneeAgentId/assigneeUserId, projectId, goalId, parentId, issueNumber, identifier, originKind, requestDepth, billingCode, executionPolicy, executionState, checkoutRunId/executionRunId, executionLockedAt, executionWorkspaceId, monitor* (nextCheckAt, wakeRequestedAt, lastTriggeredAt, attemptCount, notes, scheduledBy), assigneeAdapterOverrides`.
- **Sub‑features:** comments (+ cancel), documents (versioned, lock/unlock, restore), attachments, activity feed, interactions (accept/reject/cancel/respond), work products, external objects (refresh), feedback traces & votes, plan decompositions, checkout/release (locking), cost summary, **watchdog** config, **monitor check‑now**, **scheduled‑retry**, **tree‑control** + **tree‑holds** (dependency/parallelism gating).
- **States:** `backlog · active · done · blocked` (+ recent/all views); `workMode: standard`; `priority: high/…`.

### 5.4 Agents
- **Purpose:** hired AI agents; the org’s workforce. List views by status (active/paused/error/all); `/agents/new` hire flow; org chart at `/org`.
- **Detail tabs:** Instructions · Skills · Configuration · Runs · Budget · Dashboard.
- **Configuration** (the richest form — detailed in §6): identity/role/reports‑to, adapter + model + model profiles + reasoning effort, instructions bundle, heartbeat/runtime knobs, permissions/trust, skills, environment/env‑vars, API keys, budget.
- **Runs tab:** heartbeat‑run history with per‑run events, log (ndjson), workspace operations, watchdog decisions; cancel.
- **Org‑chain health:** each agent carries `orgChainHealth{status, reason, fullChain[], firstInvalidAncestor, invalidAncestors[], repairGuidance}` — validates the reports‑to chain.
- **Backing:** `GET/POST …/agents`, `GET …/agent-configurations`, `POST …/agent-hires`, per‑adapter `models`/`model-profiles`/`detect-model`/`test-environment`.

### 5.5 Adapters & models (registry)
- `GET /api/adapters` → 14 built‑ins, each with `capabilities{supportsInstructionsBundle, supportsSkills, supportsLocalAgentJwt, requiresMaterializedRuntimeSkills, supportsModelProfiles}`, `modelsCount`, `loaded`, `disabled`, `overridePaused`.

  | Adapter | models | bundle | skills | localJwt | materializedSkills | modelProfiles |
  |---|--:|:--:|:--:|:--:|:--:|:--:|
  | `acpx_local` | 20 | ✓ | ✓ | ✓ | — | — |
  | `claude_local` | 9 | ✓ | ✓ | ✓ | — | ✓ |
  | `codex_local` | 11 | ✓ | ✓ | ✓ | — | ✓ |
  | `cursor` | 39–42 | ✓ | ✓ | ✓ | ✓ | ✓ |
  | `cursor_cloud` | 0 | ✓ | — | — | — | — |
  | `gemini_local` | 6 | ✓ | ✓ | ✓ | ✓ | ✓ |
  | `grok_local` | 1 | ✓ | ✓ | ✓ | ✓ | — |
  | `hermes_gateway` | 0 | — | — | — | — | — |
  | `hermes_local` | 0 | ✓ | ✓ | ✓ | — | — |
  | `http` | 0 | — | — | — | — | — |
  | `openclaw_gateway` | 0 | — | — | — | — | — |
  | `opencode_local` | 5 | ✓ | ✓ | ✓ | ✓ | ✓ |
  | `pi_local` | 0 | ✓ | ✓ | ✓ | ✓ | — |
  | `process` | 0 | — | — | — | — | — |

- **Model catalogs** (`GET …/adapters/:type/models`): e.g. `claude_local` → Opus 4.8/4.7/4.6, Sonnet 4.6/4.5, Haiku 4.6/4.5, Fable 5, Mythos 5; `codex_local` → gpt‑5.5/5.4/5.3‑codex/o3…; `gemini_local` → gemini‑2.5‑pro/flash/…; `cursor` → 42 (grok‑build, composer‑1.x, auto, ollama‑*, …); `opencode_local` → openai/gpt‑5.x‑codex.
- **Config‑schema‑driven form** (`GET /api/adapters/:type/config-schema`): most local adapters return "does not provide a config schema"; **gateway** adapters do — e.g. `hermes_gateway` returns typed fields `{key,label,type,required,default,hint,options?,meta.secret?}` with types `text · toggle · select · number · textarea`. Example fields: `apiBaseUrl`, `apiKey`(secret), `dangerouslyAllowInsecureRemoteHttp`(toggle), `sessionKeyStrategy`(select: issue/agent/run/none), `timeoutSec`, `eventReconnectMs`, `paperclipApiUrl`, `headers`(textarea), `instructions`(textarea).
- **Probes:** `…/adapters/:type/detect-model` (auto‑detect installed model), `…/adapters/:type/test-environment` (validate model+env before save). Instance‑admin can override/reinstall/reload/disable adapters (`PATCH/POST /adapters/:id/...`).

### 5.6 Projects
- **Purpose:** groups issues under a codebase/initiative, linked to goal(s). **Fields (live):** `name, description, status(in_progress), goalId/goalIds[], leadAgentId, targetDate, color, icon, executionWorkspacePolicy, pauseReason/pausedAt, archivedAt, urlKey, codebase{workspaceId, repoUrl, repoRef, defaultRef, repoName, localFolder, managedFolder, effectiveLocalFolder, origin(managed_checkout)}, workspaces[], primaryWorkspace, taskCount, budget`.
- **Tabs:** Overview · Issues · Workspaces · Budget · Configuration. Backing: `GET/POST …/projects`; detail data via dashboard/company endpoints + `…/projects/:id/external-object-summary`, `plugin-operations`.

### 5.7 Goals
- Strategic objectives projects roll up to. **Fields:** `title, description, level(company), status(active), parentId, ownerAgentId`. CRUD: `GET/POST …/goals`, `GET/PATCH/DELETE /goals/:id`.

### 5.8 Routines (recurring scheduled tasks)
- **Purpose:** cron‑like recurring agent tasks with triggers. **Tabs:** Overview · Triggers · Revisions · Runs · Description(annotations). **Actions:** run‑now, list runs, list/restore **revisions** (versioned), CRUD **triggers** + **rotate trigger secret** (webhook triggers). Backing: `…/routines`, `/routines/:id/{run,runs,revisions,revisions/:rev/restore,triggers}`, `/routine-triggers/:id[/rotate-secret]`.

### 5.9 Pipelines (feature‑flagged)
- **Purpose:** multi‑stage **case** pipelines (intake → stages → transitions → outputs) with per‑stage automation. **Tabs:** Cases · Stages · Settings · Health · Transitions · Intake form. **Cases** have children/tree, outputs, events, issue‑links, transitions, review, drift acknowledgement, automation retry/rerun, and versioned documents. Backing: `…/pipelines`, `/pipelines/:id/{stages,cases,transitions,health,intake-form,documents}`, `/cases/:id/*`, `…/case-events`, `…/pipelines-attention`.

### 5.10 Approvals (human‑in‑the‑loop)
- **Purpose:** gate agent actions requiring operator sign‑off. **States:** pending → approved / rejected / needs‑revision (resubmit loop). **Actions:** approve, reject, request‑revision, resubmit, comment. Company‑ and issue‑scoped. Backing: `…/approvals`, `/issues/:id/approvals`, `/approvals/:id/{approve,reject,request-revision,resubmit,comments,issues}`. Badge via `sidebar-badges.approvals`.

### 5.11 Review Queue / Review‑cases (low‑trust quarantine)
- **Purpose:** outputs from **low‑trust** agents land quarantined and must be reviewed before becoming company‑visible. **Actions:** per‑case review, bulk actions, drift acknowledge, resolve‑suggestion, transition, open‑conversation. Backing: `…/review-cases`, `…/review-cases/bulk`, `/cases/:id/review`, `…/case-events`. Related recovery: `/issues/:id/recovery-actions/resolve`, "Recovery needed / in progress / escalated / resolved" state machine.

### 5.12 Watchdogs, monitors & recovery
- **Purpose:** keep runs healthy. **Task watchdogs** (`GET/PUT/DELETE /issues/:id/watchdog`) — kinds include `runtime`, `cost`, `no_activity`; **system watchdog kinds** (from the config surface): `stranded_assigned_issue`, `workspace_validation`, `configuration_validation`, `active_run_watchdog`, `issue_graph_liveness`. **Monitor:** `POST /issues/:id/monitor/check-now`; monitor fields on the issue (`monitorNextCheckAt`, `monitorAttemptCount`, …). **Watchdog decisions** submitted per heartbeat‑run (`POST /heartbeat-runs/:runId/watchdog-decisions`). **Recovery actions** resolve; **tree‑holds** gate dependent work. **Issue‑graph liveness auto‑recovery** is an experimental instance feature with preview/run endpoints. (Feature‑gated by `enableTaskWatchdogs`.)

### 5.13 Budgets, costs & finance
- **Budgets:** `…/budgets/overview` → `{policies[], activeIncidents[], pausedAgentCount, pausedProjectCount, pendingApprovalCount}`; `POST …/budgets/policies` (create/update policy); `POST …/budget-incidents/:id/resolve`. Agents/projects carry `budgetMonthlyCents/spentMonthlyCents` and pause with `pauseReason:"budget"`.
- **Costs:** summary + breakdowns by **agent**, **agent‑model**, **biller**, **project**, **provider**; **quota‑windows**, **window‑spend**; per‑issue cost summary.
- **Finance:** `finance-summary` (`{debitCents, creditCents, netCents, estimatedDebitCents, eventCount}`), `finance-by-biller`, `finance-by-kind`, `finance-events`. Usage metering on each run (`usageJson{model, biller, provider, billingType, inputTokens, outputTokens, cachedInputTokens, sessionReused, …}`) — e.g. `billingType:"subscription_included"`.

### 5.14 Agent trust & low‑trust review mode
- **Trust mode** per agent: `standard` ("Company‑visible collaboration. Default for normal work.") vs **`low_trust_review`** ("Contained for hostile or untrusted input. Narrow Paperclip API, quarantine…"). **Boundary set** ("Boundary type" / "Trust preset"): bounded **projects** + **issues** a low‑trust agent may touch. Outputs route through the Review Queue (§5.11). Reuses approval primitives.

### 5.15 Skills (library)
- **Purpose:** attachable capability packs from a company catalog. **Fields (live):** `key, slug, name, description, sourceType(local_path), sourceLocator, sourceRef, trustLevel(scripts_executables), compatibility(compatible), fileInventory[{path,kind}]`. **Library depth:** categories, import, install‑from‑catalog, scan‑projects, **versions**, **fork**, **star**, **install‑update** (+ update‑status), per‑skill **files** (get/patch), **comments**. Company catalog + public `/skills/catalog`. Attach on the agent Skills tab; a "Requested skills missing" warning links to the library. Agents declare `paperclipSkillSync.desiredSkills`.

### 5.16 Environments & execution workspaces
- **Environments** (feature‑gated `enableEnvironments`): reusable execution targets. **Fields:** `name, description, driver(local|ssh|sandbox|plugin), status, config{}, envVars{}, metadata{defaultForCompany, defaultForInstance, managedByPaperclip}`. **Capabilities matrix** per adapter (`…/environments/capabilities`): which drivers (local/ssh/sandbox) + sandbox providers each adapter supports. **Probe** config before use.
- **Execution workspaces:** where runs happen. **Fields:** `mode(shared_workspace), strategyType(project_primary|git_worktree|adapter_managed|cloud_sandbox), cwd, repoUrl, baseRef, branchName, providerType(local_fs), status, openedAt/closedAt, lastUsedAt, sourceIssueId, derivedFromExecutionWorkspaceId, cleanup*`. **Runtime commands & services** (start/control), **workspace operations** log, **close‑readiness** check, **environment leases** (ephemeral lease/release lifecycle, seen in activity feed). Feature‑gated by `enableIsolatedWorkspaces`.

### 5.17 Secrets & secret providers
- **Secrets:** encrypted store. Detail tabs Usage / Access‑events / Rotate. **Actions:** create, update, delete, **rotate**, usage, access‑events; **remote‑import** (+ preview). Secret‑ref binding into env vars and adapter config (`meta.secret` fields).
- **Secret providers:** external managers/vaults. **Provider configs** with discovery‑preview, set‑default, per‑config **health**, aggregate **health**. UI label "Provider vaults" (KMS‑style).

### 5.18 Members, RBAC & grants
- **Members** (`GET …/members`): `{principalType(user), principalId, status, membershipRole(owner), user{id,email,name,image}, grants[]}`. **Grants ledger** = fine‑grained `{permissionKey, scope?, grantedByUserId}` — observed keys `agents:create`, `environments:manage`, `joins:approve` (pattern `resource:action`). **Actions:** update member, archive, update **permissions**, update **role‑and‑grants**. **Invites** + **join‑requests** (approve/reject/claim‑api‑key). **User directory**, **resource‑memberships/me** (per‑user project/agent membership), **admin** user search + company‑access + promote/demote instance‑admin. **OpenClaw invite‑prompt** generator.

### 5.19 Plugins / connectors
- **Purpose:** installable integrations that can contribute UI, actions, dashboards, and local‑folder bridges. **Tabs:** Dashboard · Config · Health · Logs. **Actions:** install, enable/disable, upgrade, config (+ test), invoke actions, write data, **local‑folders** (set/validate/status), **UI contributions** (`/plugins/ui-contributions`, mounted at `/_plugins/:id/ui/...` and `/:pluginRoutePath/*`), **bridge SSE stream**, examples catalog. Backing: `/api/plugins/*`.

### 5.20 Config revisions (versioning)
- Immutable, versioned config history with `changedKeys`, `source`, timestamp and a **Restore/Rollback** action. Every config save writes a revision. Backing: `GET /config-revisions/:id`, `POST /config-revisions/:id/rollback`. Also applies to routine revisions and document revisions (issues/cases/pipelines all have versioned documents with restore).

### 5.21 Search, activity, board chat
- **Search** (`…/search?q=`): scored full‑text across issues/comments/documents/identifiers with matched‑field snippets + highlights. **Activity** (`…/activity`): append‑only audit feed (`{actorType, actorId, action, entityType, entityId, agentId, runId, details, createdAt}`; e.g. `environment.lease_released`). **Board chat** (`/api/board/chat/stream`): streaming operator/board conversation.

### 5.22 Cloud upstream / portability
- **Cloud upstreams** (feature‑gated `enableCloudSync`): push‑runs with preview/activation/cancel — sync a local company to a cloud instance. **Company import/export** (`/companies/import[/preview]`, `/company/export/*`, `/company/import`) for portability. Branding/logo assets per company.

---

## 6. Deep dive — the Agent Configuration surface

The Configuration tab composes a main settings form + an API‑Keys block + a Configuration‑Revisions history. Live agent payloads confirm the persisted shape (`adapterConfig`, `runtimeConfig`, `permissions`). Fields (grouped; enums/hints verbatim where quoted):

**A. Identity & org** — Display name · Title ("Job title shown in the org chart") · Kind/role (`ceo`, `engineer`, `general`, …) · Icon · Reports‑to ("N/A (CEO)" when null) · Capabilities (freeform) · Description · Status (`idle`/`paused` + `pauseReason`/`pausedAt`).

**B. Adapter & model** — Adapter (14 built‑ins) · Model (per‑adapter catalog) · **Detect model** · **Model profiles** (Primary model + **Cheap model** `{cheapModel, cheapModelEnabled}`; adapter‑gated by `supportsModelProfiles`) · **Reasoning/thinking effort** ("Control model reasoning depth. Supported values vary by adapter/model."; mapped per adapter — `effort`/`modelReasoningEffort`/`variant`) · Chrome toggle (claude) · Fast mode · Extra CLI args ("comma‑separated") · **Test environment** · config‑schema‑driven adapter fields.

**C. Instructions bundle** — Bundle mode `managed`/`external` ("only available for local adapters") · `instructionsRootPath` · Entry file `AGENTS.md` (default) / `TOOLS.md` · **Virtual‑file editor** (create/edit/delete files in the bundle; `/instructions-bundle/file?path=`). Live: `adapterConfig.instructionsBundleMode:"managed"`, `instructionsEntryFile:"AGENTS.md"`, paths under `~/.paperclip/instances/default/companies/:c/agents/:a/instructions/`.

**D. Runtime / heartbeat** (live `runtimeConfig.heartbeat`) — Heartbeat enabled · Interval sec · Cooldown sec · Max concurrent runs · Wake on demand · Timeout sec (`adapterConfig.timeoutSec`, 0 = none) · Grace sec (`adapterConfig.graceSec`) · Session‑key strategy (`issue`/`agent`/`run`/`none` — "Issue scoped prevents cross‑task memory bleed by default") · Max turns per run.

**E. Permissions & trust** (live `permissions`) — `canCreateAgents` · `canCreateSkills` · assign‑tasks grant · **Trust mode** (`standard`/`low_trust_review`) + boundary candidates · permission mode / non‑interactive permissions.

**F. Skills** — attach from company library; "Requested skills missing" warning; link to library.

**G. Environment/execution** — Default environment · Environment variables (key/value; "plain values or secret refs") · Env bindings (secret‑ref editor) · **Execution‑workspace policy** (`project_primary`/`git_worktree`/`adapter_managed`/`cloud_sandbox` + `baseRef`/`branchTemplate`/`worktreeParentDir`/`provisionCommand`).

**H. API Keys** — create/claim/list per‑agent named keys ("claimed once, stored securely").

**I. Budget** — `budgetMonthlyCents`/`spentMonthlyCents`; pause‑on‑budget; incidents; cost breakdowns.

**J. Configuration Revisions** — versioned history (`changedKeys`/`source`/time) + **Restore**.

---

## 7. Complete API surface

Base `/api`; company‑scoped resources under `/api/companies/:companyId/...` (abbreviated `…`). Methods are from bundle call sites (`GET` where no explicit method literal was found). Query‑string variants collapsed. This table is comprehensive (~250 endpoints); a small number of `GET?` marks are method‑inferred.

### 7.1 Auth / Session / CLI / Onboarding
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/auth/*` (`sign-in/email`, `sign-up/email`, `get-session`, `profile`) | Auth flow |
| GET/POST | `/board-claim/:token[/claim]` | Board invitation lookup/claim |
| GET/POST | `/cli-auth/challenges/:id[/approve|/cancel]` | CLI device‑auth |
| GET/POST | `/invites/:id[/accept|/revoke|/onboarding]` | Invites |
| GET | `/invites/:token/onboarding.txt` | Onboarding text |
| POST | `/join-requests/:id/claim-api-key` | Claim API key from join request |
| GET | `/health` · `/health/dev-server/restart` | Health / dev‑server restart |

### 7.2 Companies
| Method | Path | Purpose |
|---|---|---|
| GET | `/companies` · `/companies/stats` | List / per‑company counts |
| POST | `/companies/import[/preview]` | Import a company |
| GET/PATCH/DELETE | `/companies/:companyId` | Get / update / delete |
| POST | `…/archive` | Archive |
| GET | `…/dashboard` · `…/org` · `…/activity` · `…/workspace-overview` | Overview surfaces |
| PATCH | `…/branding` · POST `…/logo` · POST `…/assets/images` | Branding/logo |
| GET/POST/DELETE | `…/labels` · `/labels/:id` | Labels |
| GET | `…/artifacts` | Artifacts |

### 7.3 Agents / Agent‑configurations / Adapters
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `…/agents` | List / create agents |
| GET | `…/agent-configurations` | Agent configs |
| POST | `…/agent-hires` | Hire an agent |
| GET | `…/adapters/:type/models` · `/model-profiles` · `/detect-model` | Model catalog / profiles / detect |
| POST | `…/adapters/:type/test-environment` | Probe env+model |
| GET | `/adapters` · `/adapters/:type/config-schema` · `/adapters/:type/ui-parser.js` | Registry / schema / UI parser |
| PATCH/DELETE | `/adapters/:id` · `…/override` | Update/override (instance) |
| POST | `/adapters/:id/reinstall` · `/reload` · `/adapters/install` | Lifecycle |

### 7.4 Issues / Tasks
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `…/issues` · `…/issues/count` | List/create/count |
| GET/PATCH/DELETE | `/issues/:id` | CRUD |
| POST | `/issues/:id/checkout` · `/release` · `/read` (DELETE unread) · `/inbox-archive` | Lifecycle/inbox |
| GET/POST/DELETE | `/issues/:id/attachments` · `/attachments/:id` · `/attachments/:id/content` | Attachments |
| GET/POST/DELETE | `/issues/:id/comments[/:cid]` (`?mode=cancel`) | Comments |
| GET/PUT/DELETE | `/issues/:id/documents/:key` (+ `/lock`,`/unlock`,`/revisions`,`/revisions/:rev/restore`,`/annotations`) | Versioned docs |
| GET/POST | `/issues/:id/interactions[/:iid/{accept,reject,cancel,respond}]` | Interactions |
| GET | `/issues/:id/{activity,runs,live-runs,active-run,cost-summary,accepted-plan-decompositions,external-object-summary,external-objects,feedback-traces,feedback-votes,work-products,file-resources/*}` | Sub‑resources |
| POST | `/issues/:id/external-objects/refresh` · `/feedback-votes` · `/work-products` | Actions |

### 7.5 Runs / Heartbeat‑runs
| Method | Path | Purpose |
|---|---|---|
| GET | `…/heartbeat-runs` · `…/live-runs` | Company run lists |
| GET | `/heartbeat-runs/:id` · `/events` · `/log` · `/issues` · `/workspace-operations` | Run detail/streams |
| POST | `/heartbeat-runs/:id/cancel` · `/:runId/watchdog-decisions` | Cancel / watchdog decisions |
| POST | `/heartbeat/invoke` | Invoke a heartbeat |

### 7.6 Approvals
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `…/approvals` · `/issues/:id/approvals` (DELETE `/:aid`) | List/create |
| GET/POST | `/approvals/:id` · `/comments` · `/issues` | Detail |
| POST | `/approvals/:id/{approve,reject,request-revision,resubmit}` | Decisions |

### 7.7 Review‑cases / Cases / Pipelines
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `…/review-cases` · `…/review-cases/bulk` · `…/case-events` | Review queue |
| GET/POST/PATCH | `…/pipelines` · `/pipelines/:id` · `…/pipelines-attention` | Pipelines |
| GET/POST/PATCH/DELETE | `/pipelines/:id/{stages[/:sid[/automation-env]],cases[/batch],transitions,health,intake-form,documents/*}` | Pipeline internals |
| GET/PATCH/POST | `/cases/:id` (+ `children[/tree]`,`outputs`,`events`,`issue-links`,`transition`,`review`,`open-conversation`,`acknowledge-drift`,`resolve-suggestion`,`automation[s]/retry|current-stage/rerun`,`documents/*`) | Case ops |

### 7.8 Watchdogs / Recovery / Monitor / Tree
| Method | Path | Purpose |
|---|---|---|
| GET/PUT/DELETE | `/issues/:id/watchdog` | Watchdog config |
| POST | `/issues/:id/monitor/check-now` · `/recovery-actions/resolve` · `/scheduled-retry/retry-now` | Monitor/recovery |
| GET/POST | `/issues/:id/tree-control/{state,preview}` · `/tree-holds[/:hid[/release]]` | Dependency gating |
| GET/POST | `/instance/settings/experimental/issue-graph-liveness-auto-recovery/{preview,run}` | Liveness auto‑recovery |

### 7.9 Budgets / Costs / Finance
| Method | Path | Purpose |
|---|---|---|
| GET | `…/budgets/overview` · POST `…/budgets/policies` · POST `…/budget-incidents/:id/resolve` | Budgets |
| GET | `…/costs/{summary,by-agent,by-agent-model,by-biller,by-project,by-provider,quota-windows,window-spend}` | Cost breakdowns |
| GET | `…/costs/{finance-summary,finance-by-biller,finance-by-kind,finance-events}` | Finance |

### 7.10 Secrets / Secret‑providers
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `…/secrets` · `…/secrets/remote-import[/preview]` | Secrets |
| PATCH/DELETE/GET/POST | `/secrets/:id` · `/rotate` · `/usage` · `/access-events` | Secret ops |
| GET | `…/secret-providers[/health]` | Providers |
| GET/POST/PATCH/DELETE | `…/secret-provider-configs[/discovery/preview]` · `/secret-provider-configs/:id[/default|/health]` | Provider configs |

### 7.11 Members / RBAC / Grants / Invites / Admin
| Method | Path | Purpose |
|---|---|---|
| GET/PATCH/POST | `…/members[/:mid[/archive|/permissions|/role-and-grants]]` | Members + grants |
| GET | `…/user-directory` · `…/users/:uid/profile` | Directory |
| GET/PUT | `…/resource-memberships/me[/agents/:aid|/projects/:pid]` | Per‑user memberships |
| GET/POST | `…/invites` · `…/join-requests[?status=]` (`/:id/{approve,reject}`) | Invites/joins |
| POST | `…/openclaw/invite-prompt` | OpenClaw invite prompt |
| GET/PUT/POST | `/admin/users[?query=]` · `/:id/company-access` · `/:id/{promote,demote}-instance-admin` | Instance admin |

### 7.12 Projects / Execution‑workspaces / Environments
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `…/projects` · GET `/projects/:id/external-object-summary` | Projects |
| GET | `…/execution-workspaces` · `/execution-workspaces/:id[/close-readiness|/workspace-operations]` | Workspaces |
| PATCH | `/execution-workspaces/:id` | Update |
| POST | `/execution-workspaces/:id/runtime-commands/:cmd` · `/runtime-services/:svc` | Runtime control |
| GET | `/workspace-operations/:id/log` | Operation log |
| GET/POST/PATCH | `…/environments[/capabilities|/probe-config]` · `/environments/:id[/probe]` | Environments |
| GET | `/environment-leases/:id` | Lease |

### 7.13 Routines / Goals / Skills / Plugins / Config‑revisions / Cloud / Search
| Method | Path | Purpose |
|---|---|---|
| GET/POST/PATCH | `…/routines` · `/routines/:id[/run|/runs|/revisions|/revisions/:rev/restore|/triggers|/description/annotations]` · `/routine-triggers/:id[/rotate-secret]` | Routines |
| GET/POST/PATCH/DELETE | `…/goals` · `/goals/:id` | Goals |
| GET/POST/PATCH/DELETE | `…/skills[/categories|/import|/install-catalog|/scan-projects]` · `/skills/:id[/update-status|/install-update|/fork|/star|/versions[/:vid]|/files|/comments[/:cid]]` · `/skills/catalog[/:id[/files]]` | Skills library |
| GET/POST/DELETE | `/plugins[/examples|/install|/ui-contributions]` · `/plugins/:id[/enable|/disable|/upgrade|/health|/dashboard|/logs|/config[/test]|/actions/:a|/data/:k|/companies/:c/local-folders/*]` · SSE `/plugins/:id/bridge/stream/:sid` · `/_plugins/:id/ui/:file` | Plugins |
| GET/POST | `/config-revisions/:id[/rollback]` | Config versioning |
| GET/POST | `/cloud-upstreams[?companyId=]` · `/cloud-upstreams/:id/push-runs[/preview|/:rid[/activation|/cancel]]` | Cloud sync |
| GET | `…/search` · GET/POST `…/inbox-dismissals` · GET `…/sidebar-badges` · GET/PUT `…/sidebar-preferences/me` | Search/inbox/sidebar |
| WS | `…/events/ws` · SSE `/board/chat/stream` | Realtime |
| GET/PATCH/DELETE | `/work-products/:id` · DELETE `/keys/:key` · GET/DELETE `/instructions-bundle/file?path=` | Misc |

### 7.14 Instance settings
| Method | Path | Purpose |
|---|---|---|
| GET/PATCH | `/instance/settings[/general|/experimental]` | Instance config |
| GET | `/instance/scheduler-heartbeats` | Global scheduler heartbeat status |
| GET | `/instance` | Instance info |

> **Documented external gateway** (in help text, not app‑client calls): `POST /api/v1/runs` (start a run via gateway token), `/v1/responses`, `/chat`, `/hooks/*`.

---

## 8. Data entities & relationships

### 8.1 Core entities (fields observed from live payloads)

- **Instance** — `settings{defaultEnvironmentId, general{censorUsernameInLogs, keyboardShortcuts, feedbackDataSharingPreference, backupRetention}, experimental{…14 flags}}`.
- **Company** — `id, name, description, status, issuePrefix, issueCounter, budgetMonthlyCents, spentMonthlyCents, attachmentMaxBytes, requireBoardApprovalForNewAgents, feedbackDataSharing*, brandColor, logoAssetId, logoUrl, createdAt, updatedAt`.
- **User / Member / Grant** — User `{id, email, name, image}`; Member `{principalType, principalId, status, membershipRole, grants[]}`; Grant `{permissionKey, scope?, grantedByUserId}`.
- **Agent** — `{id, companyId, name, role, title, icon, status, reportsTo, capabilities, adapterType, adapterConfig{model, graceSec, timeoutSec, instructionsBundleMode, instructionsEntryFile, instructionsRootPath, instructionsFilePath, paperclipSkillSync{desiredSkills}}, runtimeConfig{heartbeat{enabled, cooldownSec, intervalSec, wakeOnDemand, maxConcurrentRuns}}, defaultEnvironmentId, budgetMonthlyCents, spentMonthlyCents, pauseReason, pausedAt, errorReason, permissions{canCreateAgents, canCreateSkills}, lastHeartbeatAt, urlKey, orgChainHealth{…}}` (+ config‑surface fields: trust mode, model profiles, reasoning effort — §6).
- **Goal** — `{id, companyId, title, description, level, status, parentId, ownerAgentId}`.
- **Project** — `{id, companyId, goalId/goalIds[], name, description, status, leadAgentId, targetDate, color, icon, executionWorkspacePolicy, pauseReason, pausedAt, archivedAt, urlKey, codebase{…origin:managed_checkout}, workspaces[], primaryWorkspace, taskCount, budget}`.
- **Issue/Task** — see §5.3 (deep field list).
- **HeartbeatRun** — `{id, companyId, agentId, invocationSource, triggerDetail, status, startedAt, finishedAt, error/errorCode, exitCode, signal, usageJson{model, biller, provider, billingType, input/output/cached tokens, sessionReused, persistedSessionId, sessionRotated/Reason}, sessionIdBefore/After, logStore, logRef, logBytes, logSha256, logCompressed, processPid, processGroupId, processStartedAt, lastOutputAt}`.
- **ExecutionWorkspace** — `{id, companyId, projectId, sourceIssueId, mode, strategyType, name, status, cwd, repoUrl, baseRef, branchName, providerType, providerRef, derivedFromExecutionWorkspaceId, openedAt, closedAt, lastUsedAt, cleanup*}`; **EnvironmentLease** `{driver, status, issueId, provider, leasePolicy(ephemeral), cleanupStatus, environmentId, executionWorkspaceId}`.
- **Environment** — `{id, name, description, driver, status, config, envVars, metadata{defaultForCompany, defaultForInstance, managedByPaperclip}}`.
- **Skill** — `{id, companyId, key, slug, name, description, sourceType, sourceLocator, sourceRef, trustLevel, compatibility, fileInventory[{path,kind}]}` (+ versions, stars, comments).
- **Approval, ReviewCase, Pipeline/Stage/Case, Watchdog, BudgetPolicy, Secret, SecretProviderConfig, Routine/Trigger, Plugin, ConfigRevision, Activity, Webhook** — per §5 / §7.

### 8.2 Relationship graph (text)

```
Instance ─1:N─ Company ─1:N─ { Goal ─1:N─ Project ─1:N─ Issue ─1:N─ Run(HeartbeatRun) }
Company ─1:N─ Agent (self‑ref reportsTo → org chart; orgChainHealth validates chain)
Agent ─N:1─ Adapter(+model/profiles) ; Agent ─N:1─ Environment ; Agent ─N:M─ Skill
Issue ─N:1─ Agent(assignee) ; Issue ─N:1─ Project ; Issue ─self─ parentId(tree) ; Issue ─1:N─ {Comment, Document(versioned), Attachment, Interaction, Approval, WorkProduct, Watchdog, TreeHold}
Project ─N:1─ Goal ; Project ─1:N─ ExecutionWorkspace ─1:N─ EnvironmentLease
Company ─1:N─ { Member ─1:N─ Grant, Invite, JoinRequest, Secret, SecretProviderConfig, Routine ─1:N─ Trigger, Pipeline ─1:N─ Stage/Case, BudgetPolicy, Plugin }
Any config save → ConfigRevision (versioned, restorable) ; any action → Activity(audit)
```

### 8.3 Key enums (observed / evidenced)

| Enum | Field | Values |
|---|---|---|
| Agent status | `agent.status` | `idle`, `paused`, `error`, (`running` at runtime) |
| Agent role/kind | `agent.role` | `ceo`, `engineer`, `general`, … |
| Trust mode | `agent.trustMode` | `standard`, `low_trust_review` |
| Issue status | `issue.status` | `backlog`, `active`, `done`, `blocked` (+ todo/in‑review/cancelled on the board) |
| Work mode | `issue.workMode` | `standard`, … |
| Priority | `issue.priority` | `high`, … |
| Origin kind | `issue.originKind` | `manual`, … |
| Run status | `run.status` | `succeeded`, `failed`, queued/running/cancelled |
| Invocation source | `run.invocationSource` | `automation`, (manual/api) |
| Billing type | `usageJson.billingType` | `subscription_included`, … |
| Instructions bundle mode | `adapterConfig.instructionsBundleMode` | `managed`, `external` |
| Session‑key strategy | `sessionKeyStrategy` | `issue`, `agent`, `run`, `none` |
| Workspace policy | `executionWorkspacePolicy` / `strategyType` | `project_primary`, `git_worktree`, `adapter_managed`, `cloud_sandbox` |
| Workspace mode | `executionWorkspace.mode` | `shared_workspace`, … |
| Env driver | `environment.driver` | `local`, `ssh`, `sandbox`, `plugin` |
| Adapter capability flags | `adapter.capabilities` | `supportsInstructionsBundle`, `supportsSkills`, `supportsLocalAgentJwt`, `requiresMaterializedRuntimeSkills`, `supportsModelProfiles` |
| Watchdog kind (task) | `watchdog.kind` | `runtime`, `cost`, `no_activity` |
| Watchdog kind (system) | — | `stranded_assigned_issue`, `workspace_validation`, `configuration_validation`, `active_run_watchdog`, `issue_graph_liveness` |
| Approval status | `approval.status` | `pending`, `approved`, `rejected`, `needs_revision` |
| Review‑case status | `reviewCase.status` | `quarantined`, … (review/resolve) |
| Skill trust level | `skill.trustLevel` | `scripts_executables`, … |
| Member role | `member.membershipRole` | `owner`, … |
| Grant permission key | `grant.permissionKey` | `agents:create`, `environments:manage`, `joins:approve`, … (`resource:action`) |
| Goal level | `goal.level` | `company`, … |
| Lease policy | `lease.leasePolicy` | `ephemeral`, … |

> **Field/enum completeness caveat:** §8.3 is compiled from live entity payloads + bundle string literals. It is near‑exhaustive but "observed," not provably complete (the dedicated enum‑sweep sub‑pass was cut short; nothing here is unverified, but a few low‑traffic enums may have additional members not exercised by the running instance).

---

## 9. Non‑functional aspects (visible from the app)

| Aspect | Observation |
|---|---|
| **Auth model** | better‑auth email sign‑in/up + get‑session/profile; `local_trusted` mode auto‑grants an implicit board owner; CLI device‑auth + board‑claim/invite tokens; per‑agent named API keys; per‑agent local‑agent JWT (`supportsLocalAgentJwt`). |
| **RBAC** | Company membership role + a fine‑grained **grants ledger** (`permissionKey`+`scope`); instance‑admin as a separate privilege; per‑resource memberships (project/agent). |
| **Deployment posture** | `deploymentMode` + `deploymentExposure` gate the API; private/loopback needs no auth, non‑private would. |
| **Trust & containment** | per‑agent `low_trust_review` with bounded resource set + quarantine review queue; skill `trustLevel`; dangerous‑action approvals. |
| **Secrets handling** | encrypted store, secret‑ref bindings (`meta.secret`), rotation, access‑event log, usage tracking, external secret providers/vaults with health, remote‑import with preview. |
| **Audit & versioning** | append‑only activity/audit feed; config revisions (restore); versioned documents (issues/cases/pipelines) and routine revisions; run logs content‑addressed (`logSha256`+`logBytes`). |
| **Reliability** | watchdogs (runtime/cost/no‑activity + system kinds), monitors (check‑now), recovery‑action state machine, tree‑holds, scheduled retries, issue‑graph liveness auto‑recovery; heartbeat/scheduler with cooldown/max‑concurrent; backup retention policy. |
| **Cost governance** | monthly budgets + policies, budget incidents, preflight pause‑on‑budget, cost breakdowns (agent/model/project/provider/biller), finance ledger, quota windows. |
| **Observability** | per‑run events/log streams, live‑runs, workspace‑operations logs, plugin logs/health, scheduler‑heartbeats view, dashboard KPIs + run‑activity sparkline. |
| **Extensibility** | adapter registry (14 built‑ins, config‑schema‑driven forms, install/override/reload); plugin system (UI contributions, actions, bridges, local folders); skills library (versions/fork/catalog); cloud upstream sync; company import/export. |
| **Realtime** | WebSocket per‑company event bus + SSE streams (board chat, plugin bridges, run events). |
| **Privacy** | optional username censoring in logs; feedback‑data‑sharing consent gating. |

---

## 10. Bottom line

Paperclip is a **full agent‑operations control plane**: a monochrome, flat, keyboard‑driven cockpit over a company‑scoped JSON+WS API. Its distinctive depth is in **agent runtime governance** — a 14‑adapter BYO‑runtime registry with model profiles and config‑schema forms, managed instruction bundles, heartbeat/scheduler autonomy knobs, low‑trust containment + quarantine review, watchdog/monitor/recovery machinery, versioned config/documents, a fine‑grained grants ledger, secret providers, budgets/finance metering, pipelines, and a plugin/skills ecosystem. The information architecture spans ~20 top‑level areas and ~250 API endpoints, all readable in this instance from loopback because of its `local_trusted`/`private` posture.

---

## Appendix A — Paperclip ⇄ 7Ei Mission Control parity (HAVE / PARTIAL / MISSING)

This is a *reference* view; the paper’s focus is documenting Paperclip. Grounded in our `backend/src/db/schema.ts` (33 tables) and recent commits — **Epic P/P1 (low‑trust review, #208)** and **Epic P/P2 (model profiles, #209)** have shipped since `GAP-paperclip-config.md`, so several previously‑MISSING items are now HAVE. Note an *architectural* difference: our low‑trust review is implemented as `agents.trustMode`/`trustBoundary` columns + `review.ts` + approvals (no dedicated `review_cases` table), where Paperclip has a first‑class review‑cases/pipelines entity.

| Paperclip area | Status | Where we stand |
|---|---|---|
| Identity/org (name/role/title/reportsTo/status/avatar) | ✅ HAVE | `agents` table; `orgchart.ts`, `hiring.ts` |
| Adapter **registry** (capability flags + model catalogs + config‑schema form + detect/test probes) | ✗ MISSING | `agents.runtime` enum only; no registry/probes |
| Model selection | ◐ PARTIAL | `llmProvider`+`llmModel` (single); no per‑adapter catalog |
| **Model profiles** (primary + cheap) + reasoning effort | ✅ HAVE | `agents.cheapModel`/`cheapModelEnabled`/`reasoningEffort` (Epic P/P2 #209) |
| Managed **instructions bundle** (AGENTS.md/TOOLS.md virtual‑file editor) | ◐ PARTIAL | rich persona/CV/ToR fields, but no bundle‑mode virtual‑file editor |
| Heartbeat enabled + interval | ✅ HAVE | `heartbeatEverySec`/`nextWakeAt`; `heartbeat-engine.ts` |
| Granular runtime knobs (timeout/grace/cooldown/max‑concurrent/wake‑on‑demand/session‑key/max‑turns) | ◐ PARTIAL | interval+status only |
| Permissions (create agents/skills, assign tasks) | ✅ HAVE | `agents.permissions`; `governance2.ts` |
| Execution policies (per‑action approval) | ✅ HAVE | `execution_policies` table + `governance2.ts` |
| Approvals (tri‑state + step‑up) | ✅ HAVE | `approval_requests`, `approvals.ts`, `dangerous-approvals.ts` |
| **Low‑trust review mode + boundary set + quarantine** | ✅ HAVE (arch‑diff) | `agents.trustMode`/`trustBoundary` + `review.ts` (Epic P/P1 #208); no separate review_cases entity |
| Skills attach | ✅ HAVE | `skills` table + `hiring.ts` |
| Skills **library** (versions/fork/star/catalog/scan) | ◐ PARTIAL | attach only; no versioned catalog depth |
| Execution‑workspace policy (worktree/adapter/cloud) | ◐ PARTIAL | `workspaces` table + `tasks.branch`; no policy selector |
| Per‑agent env vars + secret bindings | ✗ MISSING | secrets store exists; no per‑agent env injection surface |
| Environments (driver/capabilities/probe) | ✗ MISSING | no first‑class environment entity |
| Per‑agent API key(s) | ◐ PARTIAL | single `apiTokenHash`; no multiple named keys + access events |
| Budgets (cap/spent/incidents/breakdowns) | ✅ HAVE | `budget_policies`, `budget.ts`, `preflight.ts` |
| Config revisions (versioned + restore) | ✅ HAVE | `config_revisions` + rollback in `governance2.ts` |
| Secrets store | ✅ HAVE | `secrets` table (AES‑256‑GCM) |
| **Secret providers** (external/rotation/access‑events) | ◐ PARTIAL | local store only |
| Routines / scheduled recurring | ✅ HAVE | `scheduled_tasks`, `routines.ts`, `scheduler.ts` |
| Watchdogs (runtime/cost/no_activity) + recovery | ✅ HAVE | `task_watchdogs`, `watchdogs.ts`, `recovery.ts` |
| Plugins / connectors | ✅ HAVE | `plugins`+`plugin_jobs`, `plugins.ts`, `connectors.ts` |
| Goals | ✅ HAVE | `goals` table, `goals.ts` |
| Members / RBAC grants ledger | ◐ PARTIAL | `org_members`; org‑level roles, no per‑resource grants ledger |
| Pipelines (multi‑stage cases) | ✗ MISSING | no pipeline/case entity |
| Exports / portability | ✅ HAVE | `portability.ts` |
| Webhooks / notifications | ✅ HAVE | `webhooks`, `outbound-webhooks.ts`, `push.ts` |
| Voice (STT/TTS, ask‑vs‑execute) | ✅ HAVE (beyond Paperclip) | `voice*.ts` — no Paperclip analog |
| Memory / vault knowledge graph | ✅ HAVE (beyond Paperclip) | `vault-graph.ts`, `memory.ts`, `vector-search.ts` |
| Wallet (read/simulate/policy/signing) | ✅ HAVE (beyond Paperclip) | `wallet.ts`, `wallet-policy.ts` |

**Highest‑value remaining gaps:** adapter registry + probes; per‑agent env vars/secret bindings + first‑class environments; execution‑workspace policy selector; managed instructions bundle; skills‑library depth; multiple named API keys; secret providers; fine‑grained grants ledger; pipelines. (Low‑trust review and model profiles are now closed.)

---

## Appendix B — Full client route inventory (verbatim from the SPA)

`""` · `*` · `:companyPrefix` · `:pluginRoutePath/*` · `auth` · `onboarding` · `invite/:token` · `board-claim/:token` · `cli-auth/:id` · `u/:userSlug` · `search` · `design-guide` · `needs_attention`
**Dashboard/Inbox:** `dashboard` · `dashboard/live` · `inbox` (`/all,/blocked,/mine,/new,/recent,/requests,/unread`) · `activity` · `learnings` · `artifacts` · `board-chat` · `costs`
**Issues:** `issues` (`/active,/all,/backlog,/done,/recent,/:issueId`)
**Agents:** `agents` (`/active,/all,/paused,/error,/new,/:agentId,/:agentId/:tab,/:agentId/runs/:runId`)
**Projects:** `projects` (`/:projectId,/:projectId/{overview,issues,issues/:filter,workspaces,workspaces/:workspaceId,budget,configuration}`)
**Routines:** `routines` (`/:routineId,/:routineId/:section`)
**Pipelines:** `pipelines` (`/:pipelineId,/:pipelineId/{add,settings,stages…},/:pipelineId/cases/:caseId,/items/:caseId`)
**Approvals/Review:** `approvals` (`/all,/pending,/:approvalId`) · `review-queue`
**Goals:** `goals` (`/:goalId`)
**Org:** `org`
**Workspaces:** `workspaces` · `execution-workspaces/:workspaceId` (`/configuration,/issues,/routines,/runtime-logs,/services`)
**Skills/Plugins:** `skills/*` · `plugins/:pluginId`
**Company settings:** `company/settings` (`/access,/cloud-upstream,/environments,/instance,/invites,/members,/secrets,/:settingsRoutePath/*`) · `company/export/*` · `company/import`
**Instance settings:** `company/settings/instance/{general,profile,access,adapters,environments,heartbeats,plugins,experimental}` · `instance` · `instance/settings/*` · `instance/settings/adapters`
**Misc/dev:** `catalog/bundled/company-defaults/core-exec-team` · `ux-lab/{bootstrap-setup,cloud-upstream}` · `tests/perf/long-thread`
