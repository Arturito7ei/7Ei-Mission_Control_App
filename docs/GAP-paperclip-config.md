# GAP — Paperclip agent-configuration surface vs. 7Ei Mission Control / Arturita

> **Purpose:** competitive feature-scrape of the Paperclip agent-configuration page + a have/partial/missing gap analysis against what this repo has shipped, with a phased, story-mapped plan to close the gaps.
> **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai) · **Method:** read-only API scrape of the operator's local Paperclip instance (nothing modified in Paperclip).
> **Companion docs:** `docs/PLAN-arturita.md` (§0 story board), `docs/REQUIREMENTS-arturita.md`, `HANDOFF.md`, `STATUS.md`, `backend/src/db/schema.ts`.

---

## 0. How Paperclip was read (reproducible)

The target `http://127.0.0.1:3100/EIA/agents/r2d2/configuration` is a **client-rendered Vite/React SPA** — `curl` of the page returns only the `<div id="root">` shell. **No auth was needed:** the backing API reports `deploymentMode: "local_trusted"`, `deploymentExposure: "private"` (`GET /api/health`), so every JSON endpoint is reachable from the host loopback without a session cookie. The surface was reconstructed three ways, cross-checked:

1. **Live JSON API** — `GET /api/companies`, `GET /api/agents/r2d2?companyId=…`, `GET /api/adapters`, etc. The URL slug `EIA` is a **company `issuePrefix`**, not a tenant path — it maps to company id `498342a5-d933-4f58-a73d-f1c6d721b63d` ("7Ei"). Agent `r2d2` = `16f2ef99-8e8e-4669-a354-d91204306d68`, role `ceo`, adapter `grok_local`.
2. **SPA bundle** (`/assets/index-*.js`, 4.85 MB) — extracted every `/api/...` path template (the full control-plane resource map, ~180 routes) and the configuration form's field labels, hint text, toggles, and enums (survive minification as string literals).
3. **Adapter registry** — `GET /api/adapters` enumerates 14 built-in adapters + per-adapter model counts and capability flags.

This is an **exact** read of the running instance (`version 2026.626.0`), not guesswork.

---

## 1. Full inventory — the agent Configuration surface

The agent detail page has tabs **Instructions · Skills · Configuration · Runs · Budget**. The **Configuration** tab (`THt`) composes three blocks: the **main settings form** (`RHt`), an **API Keys** block (`$Ht`), and a **Configuration Revisions** history (versioned, restorable). Fields below are grouped by the form's section; enums/hints are verbatim from the bundle.

### A. Identity & org
| Field | Type | Notes (verbatim hint where quoted) |
|---|---|---|
| Display name | text | "Display name for this agent." |
| Title | text | "Job title shown in the org chart." e.g. "VP of Engineering" |
| Kind / role | select | `ceo`, `general`, … |
| Icon | icon picker | avatar/icon |
| Reports to | agent picker | "The agent this one reports to in the org hierarchy." (`N/A (CEO)` when null) |
| Capabilities | textarea | "Describes what…" (freeform capability description) |
| Description | textarea | — |
| Status | select | `idle` / `paused` (+ `pauseReason`, `pausedAt`) |

### B. Adapter & model
| Field | Type | Notes |
|---|---|---|
| Adapter | select | 14 built-ins: `acpx_local`(20 models), `claude_local`(9), `codex_local`(11), `cursor`(39), `cursor_cloud`, `gemini_local`(6), `grok_local`(1), `hermes_gateway`, `hermes_local`, `http`, `openclaw_gateway`, `opencode_local`(5), `pi_local`, `process`. Capability flags per adapter: `supportsInstructionsBundle`, `supportsSkills`, `supportsLocalAgentJwt`, `requiresMaterializedRuntimeSkills`, `supportsModelProfiles`. |
| Model | select | per-adapter model catalog (`/companies/:c/adapters/:a/models`) |
| Detect model | action | `/adapters/:a/detect-model` — auto-detect installed model |
| Model profiles | group | **Primary model** + **Cheap model** (`cheapModel` + `cheapModelEnabled` → `modelProfiles.cheap`). Adapter-gated by `supportsModelProfiles`. |
| Reasoning / thinking effort | select | mapped per-adapter: `effort` (claude), `modelReasoningEffort` (codex), `variant` (opencode) |
| Chrome | toggle | `claude_local` browser tool |
| Fast mode | toggle | `fastMode` |
| Extra CLI args | text | "Extra CLI arguments for local adapters, comma-separated." |
| Test environment | action | `/adapters/:a/test-environment` — probe model+env works before saving |
| Adapter config schema | dynamic form | `/adapters/:a/config-schema` drives adapter-specific fields |

### C. Instructions bundle
| Field | Type | Notes |
|---|---|---|
| Bundle mode | select | `managed` / `external`. "Instructions bundles are only available for local adapters." |
| Instructions root path | path | absolute path to bundle root |
| Entry file | text | `AGENTS.md` (default), `TOOLS.md`, … |
| Virtual files | file editor | create / edit / delete files inside the bundle ("virtual file", "File contents", "# Agent instructions") |
| Prompt template / bootstrap prompt | textarea | seed prompt (hidden on this tab; present on Instructions tab) |

### D. Runtime / heartbeat
| Field | Type | Verbatim hint |
|---|---|---|
| Heartbeat enabled | toggle | "Run this agent automatically on a timer. Useful for periodic tasks like checking for new work." |
| Interval (sec) | number | "Seconds between automatic heartbeat invocations." |
| Timeout (sec) | number | "Maximum seconds a run can take before being terminated. 0 means no timeout." |
| Grace (sec) | number | "Seconds to wait after sending interrupt before force-killing the process." |
| Wake on demand | toggle | "Allow this agent to be woken by assignments, API calls, UI actions, or automated systems." |
| Cooldown (sec) | number | "Minimum seconds between consecutive heartbeat runs." |
| Max concurrent runs | number | "Maximum number of heartbeat runs that can execute simultaneously for this agent." |
| Session key strategy | select | `issue` / … — "reduce task memory bleed by default" (isolates run memory) |
| Max turns per run | number | `maxTurnsPerRun` (default 1000) |

### E. Permissions & trust
| Field | Type | Notes |
|---|---|---|
| Can create new agents | toggle | `canCreateAgents` |
| Can create/import skills | toggle | `canCreateSkills` |
| Can assign tasks | toggle | `tasks:assign` grant |
| Trust mode | select | `standard` ("Company-visible collaboration. Default for normal work.") vs **`low_trust_review`** ("Contained for hostile or untrusted input. Narrow Paperclip API, quarantine…") |
| Boundary candidates | pickers | for low-trust: bounded **projects** + **issues** the agent may touch |
| Permission mode | select | adapter session `permissionMode` + `nonInteractivePermissions` (per-run autonomy) |

### F. Skills (attached)
| Field | Type | Notes |
|---|---|---|
| Skills applied / Selected skills | multi-select | attach from the **company skills library** |
| Requested skills missing | warning | "Import skills into the company library first, then attach them here." |
| View company skills library | link | company catalog |

### G. Environment / execution workspace
| Field | Type | Notes |
|---|---|---|
| Default environment | select | `defaultEnvironmentId` → company environments |
| Environment variables | key/value editor | "Environment variables injected into the adapter process. Use plain values or secret refs." |
| Env bindings | secret-ref editor | bind env keys to secrets from the store |
| Execution workspace policy | select | `project_primary` / `git_worktree` / `adapter_managed` / `cloud_sandbox`; + `baseRef`, `branchTemplate`, `worktreeParentDir`, `provisionCommand`. Company flag `enableIsolatedWorkspaces`. |

### H. API Keys (per-agent)
Create / claim / list per-agent API keys ("Create API Key"; keys claimed once, stored securely). Separate from the org-level board key.

### I. Budget (tab + config)
`budgetMonthlyCents`, `spentMonthlyCents`; pause-on-budget (`pauseReason: "budget"`), budget incidents + resolve, cost breakdowns (by agent/model/project/provider/biller, quota windows, finance events).

### J. Configuration Revisions
Immutable versioned config history with `changedKeys`, `source`, timestamp, and a **Restore** action (`rollbackConfigRevision`). Every save writes a revision.

### Sibling company-level config (trivially reachable, same control plane)
Secrets + **secret providers** (list/rotate/usage/access-events/remote-import/discovery/health) · **Routines** (recurring scheduled tasks + triggers + revisions) · **Approvals** queue (approve/reject/request-revision/resubmit/comments) · **Watchdogs** (task-level: `runtime`/`cost`/`no_activity`; system kinds: `stranded_assigned_issue`, `workspace_validation`, `configuration_validation`, `active_run_watchdog`, `issue_graph_liveness`) + **recovery actions** · **Environments** (capabilities/probe/test) · **Projects/workspaces** · **Budgets/policies** + costs · **Members** + permissions + **role-and-grants** (RBAC) · **Review cases** (low-trust quarantine queue, bulk) · **Goals** · **Pipelines** · **Exports** (portability) · **Plugins/integrations** (enable/disable/config/test/health/logs/upgrade/actions/local-folders/bridge streams) · **Branding/logo**.

---

## 2. Gap analysis vs. this repo

Grounded in `backend/src/db/schema.ts` (33 tables), `backend/src/services/*`, and `PLAN-arturita.md §0`. Legend: **HAVE** ✅ · **PARTIAL** ◐ · **MISSING** ✗.

| # | Paperclip feature | Status | Where we stand (citation) |
|---|---|---|---|
| A | Identity: name/role/title/reportsTo/capabilities/status | ✅ HAVE | `agents` table: `name,role,title,jobDescription,reportsTo,status,avatarEmoji`; `orgchart.ts`, `hiring.ts` (MCA-PC A1) |
| A | Icon/avatar | ✅ HAVE | `agents.avatarEmoji` |
| B | Adapter selection | ◐ PARTIAL | `agents.runtime` enum (`internal\|openclaw\|cursor\|claude_code\|custom`) exists, but no **adapter registry** with per-adapter capability flags / model catalogs / config-schema form |
| B | Model selection | ◐ PARTIAL | `agents.llmProvider` + `llmModel` (single model); no per-adapter model catalog or `detect-model` |
| B | Model profiles (primary + **cheap model**) | ✗ MISSING | no cheap-model / dual-profile routing on the agent record |
| B | Reasoning/thinking effort selector | ✗ MISSING | `llm-router.ts` streams but no per-agent effort/variant field |
| B | Test-environment / detect-model / probe | ✗ MISSING | no pre-save adapter probe endpoint |
| B | Extra CLI args / Chrome / fast mode flags | ✗ MISSING | not modeled per-agent |
| C | Instructions (persona/CV/ToR/job desc) | ◐ PARTIAL | `agents.personality,persona,cv,termsOfReference,jobDescription,expertise` — rich, but **no managed instructions bundle** (AGENTS.md/TOOLS.md virtual-file editor, bundle mode) |
| D | Heartbeat enabled + interval | ✅ HAVE | `agents.heartbeatEverySec,nextWakeAt,heartbeatStatus`; `heartbeat-engine.ts` (MCA-PC C1) |
| D | Timeout / grace / cooldown / max-concurrent / wake-on-demand / session-key-strategy / max-turns | ◐ PARTIAL | only interval + status modeled; the granular run-control knobs are absent |
| E | Permissions (create agents/skills, assign tasks) | ✅ HAVE | `agents.permissions` JSON capability list (MCA-GOV2 S4.2); `governance2.ts` |
| E | Execution policies (which actions need approval) | ✅ HAVE | `execution_policies` table + `governance2.ts` (MCA-GOV2 S4.1) — parallels Paperclip per-action gating |
| E | Approvals (tri-state + step-up + verbatim summary) | ✅ HAVE | `approval_requests` table, `approvals.ts`, `dangerous-approvals.ts`, `governance.ts` — Arturita **A2** (#175), **A3** (#176) |
| E | **Trust mode: `low_trust_review` + quarantine review queue + boundary candidates** | ✗ MISSING | we have ask-mode + approvals, but **no low-trust containment mode**, no review-cases/quarantine queue, no per-agent project/issue boundary set |
| E | Permission mode / non-interactive permissions (per-run autonomy) | ◐ PARTIAL | capability list exists; no per-run permission-mode selector |
| F | Skills attach | ✅ HAVE | `agents.skills` + `skills` table + skills route/`hiring.ts` |
| F | Skills **library** (catalog/versions/fork/star/install-catalog/scan-projects/comments) | ◐ PARTIAL | attach works; no versioned company catalog with fork/star/install-update |
| G | Execution workspace | ◐ PARTIAL | `workspaces` table + `tasks.workspaceId,branch`, `workspaces.ts` — but no **workspace-policy selector** (`git_worktree`/`adapter_managed`/`cloud_sandbox` + baseRef/branchTemplate/provisionCommand) |
| G | Per-agent env vars + secret bindings | ✗ MISSING | `secrets.ts` store exists but no per-agent/per-env **env-var injection + secret-ref binding** surface |
| G | Environments (capabilities/probe/test) | ✗ MISSING | no first-class environment entity |
| H | Per-agent API key(s) | ◐ PARTIAL | `agents.apiTokenHash` + rotate (single token, `agent-api.ts`); no **multiple named keys** + usage/access-events |
| I | Budget (monthly cap, spent, pause-on-budget, incidents, cost breakdowns) | ✅ HAVE | `budget_policies` table, `budget.ts`, `preflight.ts` per-wake cap, costs route; Arturita **F1** preflight cap (#187) |
| J | Configuration revisions (versioned + restore) | ✅ HAVE (backend) / ◐ UI | `config_revisions` table + rollback in `governance2.ts` (MCA-GOV2 S4.1); confirm a UI restore surface exists |
| S | Secrets store | ✅ HAVE | `secrets` table, `secrets.ts` (AES-256-GCM) |
| S | **Secret providers** (external managers, rotation, access-events, remote-import, discovery) | ◐ PARTIAL | local encrypted store only; no external provider integration / rotation / access-event log |
| S | Routines / scheduled recurring tasks + triggers | ✅ HAVE | `scheduled_tasks` table, `routines.ts`, `scheduler.ts`, `scheduled.ts` route |
| S | Watchdogs (runtime/cost/no_activity) + recovery | ✅ HAVE | `task_watchdogs` table, `watchdogs.ts`, `recovery.ts`; Arturita **F2** (#182) |
| S | Plugins / connectors / integrations | ✅ HAVE | `plugins` + `plugin_jobs` tables, `plugins.ts`, `connectors.ts` |
| S | Goals | ✅ HAVE | `goals` table, `goals.ts` |
| S | Members / RBAC (role-and-grants) | ◐ PARTIAL | `org_members` table; org-level roles, but no fine-grained per-resource **grants** ledger like Paperclip's |
| S | Exports / portability | ✅ HAVE | `portability.ts` |
| S | Webhooks / notifications | ✅ HAVE | `webhooks` table, `outbound-webhooks.ts`, `push.ts` |
| — | Voice (STT/TTS, ask-vs-execute) | ✅ HAVE (beyond Paperclip) | `voice*.ts`; Arturita **B1/B2/B3** — Paperclip's config page has **no** voice surface |
| — | Memory / vault knowledge graph | ✅ HAVE (beyond Paperclip) | `vault-graph.ts`, `memory.ts`, `agent-memory.ts`, `vector-search.ts`; Arturita **M1–M3** (#192/#194) |
| — | Wallet (read/simulate/policy/signing) | ✅ HAVE (beyond Paperclip) | `wallet.ts`, `wallet-policy.ts`; Arturita **E1/E2** — no analog in Paperclip |

### Counts
- **HAVE (✅):** 18 (incl. 3 capabilities beyond Paperclip: voice, memory graph, wallet)
- **PARTIAL (◐):** 9
- **MISSING (✗):** 7

### Notable MISSING / thin (ranked by value)
1. **Low-trust review mode + quarantine review-cases queue + per-agent boundary set** — the biggest safety-surface gap; aligns directly with our A-epic spine.
2. **Model profiles (primary + cheap model) + reasoning-effort selector** — cost control; slots straight into the free-first J2 pipeline.
3. **Managed instructions bundle** (AGENTS.md/TOOLS.md virtual-file editor + bundle mode).
4. **Adapter registry** (capability flags + per-adapter model catalog + config-schema-driven form + `test-environment`/`detect-model` probe).
5. **Per-agent env vars + secret-ref bindings** and **execution-workspace policy selector** (worktree/adapter-managed/cloud-sandbox).
6. **Multiple named per-agent API keys** (+ usage/access-events).
7. **Secret providers** (external managers, rotation, access-events) and **skills-library depth** (versions/fork/star/catalog).

---

## 3. Plan to close the gaps

New epic in `PLAN-arturita.md §0`: **Epic P — Paperclip config parity**. One PR per story, squash-merged with `--admin`; pure-helper services + `node --test`; idempotent `setup.ts` ALTERs (never rename columns); colorblind-safe UI (DESIGN_SYSTEM v2); invariant green each merge. Phased by value/effort; several are cheap because the backend already exists and only the config surface is missing.

### Phase P0 — surface what we already have (low effort)
| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **P1** · Config-revisions restore UI | Surface `config_revisions` + `governance2` rollback on the agent config page: revision list (`changedKeys`, actor, source, time) + **Restore**. | Each save shows a revision; Restore reverts and writes a new forward revision; boot/auth-scoping green. | — |
| **P2** · Granular heartbeat/runtime controls | Add `timeout_sec`, `grace_sec`, `cooldown_sec`, `max_concurrent_runs`, `wake_on_demand`, `session_key_strategy`, `max_turns_per_run` to `agents` (idempotent ALTER); honor in `heartbeat-engine.ts` + executor. | Timeout terminates a run (0 = none); cooldown/max-concurrent enforced; wake-on-demand toggle gates assignment-wakes; session-key strategy isolates run memory. Pure helper tests. | — |
| **P3** · Per-agent env vars + secret bindings | Per-agent `env_vars` (plain) + `env_bindings` (secret refs into `secrets.ts`); injected at run start by the executor; secret refs resolved, never logged. | Env vars reach the run; secret-ref values resolve from the store and never appear in logs/prompts/API I/O; tests cover injection + redaction. | secrets.ts |

### Phase P1 — safety parity (high value — aligns with the A-epic spine)
| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **P4** · Low-trust review mode + boundary set | Per-agent `trust_mode` (`standard`\|`low_trust_review`); when low-trust, restrict the agent to a **bounded set of projects/issues** and route its outputs through a **quarantine review queue** before they're company-visible. New `review_cases` table + `review.ts` (pure decision helpers). | A low-trust agent can only act within its boundary set; its work products land `quarantined` and require an operator approve/reject before promotion; escape attempts refused + logged. Reuses A2 approval primitives. Pure tests over the boundary + promotion logic. | A2, A3 |
| **P5** · Model profiles (primary + cheap) + reasoning effort | Extend the J2 pipeline + `agents` with `model_profiles` (`primary`, `cheap{enabled,model}`) and per-agent `reasoning_effort`; router picks cheap for low-stakes/heartbeat turns, primary otherwise; effort mapped per provider. | Cheap profile used for configured low-stakes turns, primary for the rest; effort flows to the provider call; F1 breaker still applies per profile; preflight cost cap honored. Pure router tests. | J2, F1 |

### Phase P2 — runtime depth
| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **P6** · Adapter registry + probe | `GET /adapters` registry with capability flags + per-adapter model catalog; `POST …/adapters/:a/test-environment` + `detect-model` probes; config-schema-driven adapter form. | Config page lists adapters with model catalogs + capability flags; a probe reports pass/fail with the resolved model before save; unknown adapter → clear error. Auth-scoping + probe tests. | P2 |
| **P7** · Managed instructions bundle | Bundle mode (`managed`\|`external`) + entry file (`AGENTS.md`/`TOOLS.md`) + **virtual-file editor** (create/edit/delete) materialized to the run; reuses `document-ingest.ts` where possible. | Bundle files render into the agent's system prompt/run at start; edits versioned via `config_revisions`; external mode points at a path without materializing. Tests over materialization + precedence. | P1 (revisions) |
| **P8** · Execution-workspace policy selector | Per-agent/task workspace policy (`project_primary`\|`git_worktree`\|`adapter_managed`\|`cloud_sandbox`) + `base_ref`/`branch_template`/`worktree_parent_dir`/`provision_command`; extend `workspaces.ts`. | Selected policy drives checkout/branch creation; worktree isolation verified; provision command runs once per workspace; fail-closed on an invalid policy. Tests over each policy path. | workspaces.ts |

### Phase P3 — ecosystem parity (lower urgency)
| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **P9** · Multiple named per-agent API keys | Move from single `apiTokenHash` to a `agent_api_keys` table (named keys, create/claim/rotate/revoke, last-used, access-events); keep the existing token working (migration). | An agent can have ≥2 named keys; revoking one leaves others valid; usage/access-events recorded; old single-token path still authenticates. Auth tests. | agent-api.ts |
| **P10** · Skills-library depth | Company skills catalog with versions, fork, star, `install-catalog`, `scan-projects`, comments — layered on the existing `skills` table. | Skills carry versions; fork/star/install-update work; a project scan proposes skills; attach still works. Tests over versioning + install. | skills route |
| **P11** · Secret providers + rotation | External secret-provider configs (discovery/remote-import/health) + rotation + access-event log, on top of `secrets.ts`. | A remote provider can be linked, its secrets imported/rotated, and every access logged; local store unchanged as the default. Redaction + rotation tests. | secrets.ts |
| **P12** · Fine-grained grants ledger (RBAC) | Per-resource grants (`principal`, `permission_key`, `scope`) beyond org-level roles, mirroring Paperclip's `role-and-grants`. | A grant scopes a principal to a resource/permission; revocation immediate; existing role checks still pass. Auth-scoping tests. | org_members |

### Sequencing
```
P0 (P1·P2·P3)  →  P1 (P4·P5)  →  P2 (P6·P7·P8)  →  P3 (P9·P10·P11·P12)
   surface        safety+cost      runtime depth       ecosystem
```
- **Start with P0** — mostly UI/ALTER over backends that already exist; fast parity wins.
- **P4 (low-trust review)** is the highest-value net-new; it extends the A-epic safety spine and should not be reordered after the runtime-depth phase.
- **P5 (model profiles)** plugs into the already-shipped J2 free-first pipeline — near-term cost lever.
- P3 items are genuine net-new subsystems; schedule after the parity/safety phases unless the operator prioritizes one.

---

## 4. Bottom line
Mission Control already **is** a Paperclip-class control plane — approvals, execution policies, config revisions, watchdogs, budgets/preflight, routines, secrets, skills, plugins, org chart, workspaces, RBAC — **plus** three things Paperclip's config page has no analog for (**voice**, **vault memory graph**, **wallet**). The gaps are concentrated in the **agent-configuration surface**: low-trust containment, model profiles, adapter registry + instructions bundle, per-agent env/secrets + workspace policy, and ecosystem depth (named API keys, skills library, secret providers, grants). Phase P0 closes the cheap parity gaps immediately; P4 (low-trust review) is the marquee net-new item.
