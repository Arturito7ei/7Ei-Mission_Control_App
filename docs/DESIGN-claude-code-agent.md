# DESIGN — Claude Code as a first-class engineering agent

> **Status:** design / feasibility (2026-07-13). Read-only investigation; no integration built yet.
> **Companions:** `docs/TRD-paperclip.md` (the north-star adapter model), `docs/GAP-paperclip-config.md` (adapter-registry gap), `docs/PLAN-arturita.md` §0 (story tracker — the **CC** epic stub lives there), `backend/CLAUDE.md` + `adapters/CLAUDE.md`.
> **Question answered:** Can Claude Code (the coding agent that drives these host sessions) become a first-class agent *inside* the Mission Control office — directly assignable by the office/Arturita, reporting status + results back into task threads — instead of the operator hand-spawning sessions from outside?

---

## 0. TL;DR — feasibility verdict

**Mostly-yes, and the shortest path is small.** The office side is already built. `claude_code` is a first-class, validated runtime value **end-to-end** — DB column, registration Zod enum, hire proposal, onboard CLI, the Add-Agent wizard (🤖 tile, Anthropic Sonnet default), the fleet badge, and even a reserved git-branch namespace (`cc/…`). Every downstream mechanism an engineering agent needs — task assign → claim → in-thread comments → work-product attachments → result → heartbeat → wake-on-comment → approvals → budgets → per-agent trust — **already applies to a `claude_code` agent with zero backend changes**, because the executor routes any non-`internal` runtime down the external "assign + notify, then it polls" path.

**What is missing is exactly one thing: a host-side executor adapter.** There is no `adapters/claude-code/` daemon that (a) polls the agent API for tasks assigned to the Claude Code agent, (b) spawns a headless `claude` run in the target repo/worktree, and (c) posts logs + result + heartbeat back. Everything else is reuse. Build that one poll-loop adapter (a sibling of `adapters/openclaw/mc_adapter.py` / `adapters/cursor/cursor_adapter.py`) and Claude Code becomes a real member of the fleet — and every existing guardrail (A2 approval, low-trust review, preflight/budget caps, host denylist, run-token scoping) applies to it for free.

**One-line verdict:** *Possible today, mostly by reuse. Net-new = one host adapter + a small UI/CLI polish + a safety default flip. No new backend endpoints required for the MVP.*

---

## 1. How an external agent works today (the office side — all reused)

Mission Control already has a complete "bring-your-own runtime" surface, shipped under the **MCA-EXT** and **MCA-PC** epics. An "external" agent is any agent whose `runtime !== 'internal'` (or `agentType === 'external'`) — `isExternalAgent()`, `backend/src/services/agent-runtime.ts:10-12`.

### 1.1 Identity, registration & token
- **Runtime column** — `agents.runtime text default 'internal'`, plus `externalEndpoint` (optional push URL), `apiTokenHash`, `heartbeatStatus`, `lastHeartbeatAt`, `permissions`, `trustMode`, `trustBoundary`, `contactChannel` — `backend/src/db/schema.ts:56-77`. Free-text column → **no migration needed** to store `claude_code`.
- **Register** — `POST /api/orgs/:orgId/agents/external` (`backend/src/routes/agents.ts:344-376`). `ExternalAgentSchema` validates `runtime: z.enum(['openclaw','cursor','claude_code','custom'])` — **`claude_code` is already an accepted value.** Sets `agentType:'external'`, mints a token, stores only its sha256 hash, returns the raw token **once**.
- **Token** — `mca_` + 32 random bytes hex; sha256-hashed in DB; verified into `req.agent` by the `agentAuth` bearer hook. `generateAgentToken()` / `hashToken()` — `backend/src/middleware/agent-token.ts:14-25`, `:46-63`. Rotate via `POST /api/agents/:agentId/rotate-token` (`agents.ts:379-387`, guarded by `isExternalAgent`).
- **Onboard CLI** — `npx @7ei/mc onboard --runtime claude_code …` (`cli/mc.mjs`, `cli/onboard.mjs:8` `RUNTIMES` already includes `claude_code`). One Clerk-authed flow: create org (optional) → create external agent → print `export MC_AGENT_TOKEN=…` once. Shipped as **MCA-85 D2** (`STATUS.md:121`).
- **Add-Agent wizard** — `web/app/dashboard/cockpit/AddAgentWizard.tsx:14` already renders a **Claude Code 🤖** runtime tile (default `claude-sonnet-4`, Anthropic), POSTs `/agents/external`, and prints a one-time token + `mc.env` block.

### 1.2 The task lifecycle (the agent-facing API — `backend/src/routes/agent-api.ts`)
All routes sit behind the `agentAuth` hook (`:83`), scoped to the single agent resolved from the token. This is the whole contract a runtime speaks:

| Step | Endpoint | Notes |
|---|---|---|
| Pull queue | `GET /api/agent/tasks?state=assigned` | `:305-330`; enriches workspace tasks with runtime/branch/worktree info |
| Claim | `POST /api/agent/tasks/:taskId/claim` | `:333-378`; atomic CAS `assigned→in_progress` + `lockToken`, enforces blocker deps, **resumes `sessionState`** from the prior run, returns `{ runId, sessionState }` |
| Stream progress | `POST /api/agent/runs/:id/log` | `:189-202`; append log line, update tokens/cost, persist `sessionState` |
| Comment in-thread | `POST /api/agent/tasks/:taskId/comment` | `:205-215`; authored as the agent |
| Attach work product | `POST /api/agent/tasks/:taskId/attachment` | `:218-241`; markdown → committed to the shared vault, or a link |
| Report result | `POST /api/agent/tasks/:taskId/result` | `:381-421`; `{output,status:done\|failed}`; releases lock, sets `inboxState` (`awaiting_review`/`needs_attention`), posts a system-notice on failure |
| Heartbeat | `POST /api/agent/heartbeat` | `:295-302`; `green\|amber\|stale`; freshness derived at `agent-runtime.ts:20-28` (green <2m, amber <10m) |
| Request sign-off | `POST /api/agent/approvals` | `:424-433`; files a pending human approval |
| Mint run-token | `POST /api/agent/run-token` | `:257-264`; 15-min HMAC scoped to `{agentId,orgId,runId}` |
| Scoped secrets | `GET /api/agent/secrets` | `:101-106`; decrypted org+agent secrets to inject as env |
| Shared memory | `GET/PUT /api/agent/memory/*` | vault read/write/session-summary (capability-gated) |

### 1.3 How a task reaches an external agent
`executeAgentTask()` (`backend/src/services/agent-executor.ts:31`) **short-circuits** for any external runtime (`:59-73`): it sets the task `status:'assigned', assignedTo: agent.id`, calls `notifyExternalAgent()`, and returns a placeholder (`provider:'external'`, zero cost) **without running the LLM loop**. `notifyExternalAgent()` (`agent-runtime.ts:33-48`) fires a best-effort org-scoped `agent.task.assigned` webhook.

> **Design fact to internalise:** transport is **poll-based**. The webhook is a low-latency *nudge*, not the delivery mechanism; `agent.externalEndpoint` is a dormant field `notifyExternalAgent()` does not even read. The source of truth is the adapter polling `GET /api/agent/tasks`. **Wake-on-comment** works the same way: a comment re-enters `executeAgentTask` → re-assign + nudge → the agent picks it up on its next poll.

### 1.4 Workspaces & the reserved `cc/` branch namespace
The control plane already hands a repo/branch/worktree to a coding runtime. `RUNTIME_BRANCH = { openclaw:'claw', cursor:'cursor', claude_code:'cc' }` (`agent-api.ts:15`) drives deterministic branch naming: a `claude_code` task on a workspace gets a branch like `cc/<slug>-<taskShort>` via `operatorBranch()` (`backend/src/services/workspaces.ts:11-16`), and `workspaceRuntime()` (`:25-34`) returns `{ worktree, repoUrl, baseBranch, branch }` — everything a self-hosted coder needs to `git worktree` and start. Shipped as **MCA-PC D1**.

### 1.5 The fleet UI already renders it
`AgentFleet.tsx` shows each agent with a runtime badge (`RUNTIME_BADGE[a.runtime]`), heartbeat status icon, provider·model, and pause/resume/terminate/ask controls. `RUNTIME_BADGE` already maps `claude_code: '🤖'` (`web/app/dashboard/cockpit/shared.tsx:39`). **A Claude Code agent shows up on the fleet, org chart, and hire screens correctly today.**

---

## 2. The gap — what a "Claude Code agent" actually needs

Three surfaces, only the first is load-bearing:

1. **[NET-NEW · required] A host-side Claude Code adapter** — `adapters/claude-code/`. A poll-loop daemon that authenticates with the agent token, pulls assigned tasks, checks out the workspace/worktree, spawns a **headless `claude` run** with the task prompt, streams logs, and posts the result + heartbeats. This is the only piece without which nothing works.
2. **[POLISH · small] UI/CLI adapter wiring** — `HireDialog.tsx:40-45` branches only on `cursor` vs OpenClaw, so a `claude_code` hire currently prints the *OpenClaw* adapter run-command. Add a `claude_code` branch pointing at the new adapter. The `AddAgentWizard` `mc.env` block hardcodes OpenClaw-style `MC_EXECUTOR=auto`; give it a Claude-Code profile. `externalEndpoint` isn't collected in the wizard (CLI/raw-body only) — optional to add.
3. **[SAFETY · required default] Secure-by-default registration** — the external-create endpoint doesn't set `permissions`/`trustMode`/`trustBoundary`, so a code-executor lands **allow-all / standard-trust**. For an agent that runs code on a host, the default must flip (see §5).

There is **no `Dispatch` orchestrator and no `start_code_task` mechanism in the repo** — both return zero source hits (the one "dispatch" mention says Arturita is explicitly *not* a dispatcher, `docs/PRD-jarvis-tab.md:12`). So "Dispatch" is the *operator's out-of-band habit* of hand-spawning sessions, not code. Formalizing it (option B below) is net-new — and the adapter approach subsumes it.

---

## 3. Recommended architecture

**Option A — a poll-loop Claude Code adapter (recommended).** Mirror `adapters/openclaw/mc_adapter.py` (autonomous poll loop) for the control flow, borrow the `adapters/cursor/cursor_adapter.py` inbox/result-file pattern for handing a task to a coding agent, and swap the executor for a headless `claude` invocation. Register once as `runtime:'claude_code'`; everything downstream is reuse.

```
┌──────────────────────── 7Ei Mission Control (office) ─────────────────────────┐
│                                                                                │
│  Arturita / operator ── assign task ──▶ tasks(status='assigned',              │
│                                              assignedTo=<claude-code agent>)    │
│                                                     │                           │
│   executeAgentTask() sees runtime≠internal ─────────┘                           │
│      → set 'assigned' + notifyExternalAgent() (best-effort webhook nudge)       │
│                                                                                │
│   agent-api.ts (Bearer mca_… , scoped to req.agent):                            │
│     GET /tasks · POST /claim · /runs/:id/log · /comment · /attachment           │
│     /result · /heartbeat · /approvals · /run-token · GET /secrets               │
└───────────────▲───────────────────────────────────────────────▲───────────────┘
                │ poll (source of truth)          post logs/result│  heartbeat
                │                                                  │
┌───────────────┴──────────────────────────────────────────────┴────────────────┐
│  HOST  ·  adapters/claude-code/  (NET-NEW daemon, launchd keep-alive)           │
│                                                                                │
│  loop:                                                                          │
│   1. heartbeat('green'); load_secrets() → env                                   │
│   2. GET /tasks?state=assigned                                                  │
│   3. POST /claim  → { runId, sessionState, workspace{worktree,branch=cc/…} }    │
│   4. git worktree add <worktree> <cc/branch>   (if workspace-scoped)            │
│   5. spawn HEADLESS:  claude -p "<task input>"  --output-format stream-json     │
│        · working dir = worktree/MC_WORKDIR                                       │
│        · stream stdout → POST /runs/:runId/log (+ tokens/cost)                   │
│        · dangerous ops → POST /approvals (block until decided)                   │
│   6. POST /result { output, status }  · commit work product via /attachment     │
│   7. sleep(POLL); repeat                                                         │
└────────────────────────────────────────────────────────────────────────────────┘
```

Why A wins: it reuses the entire assign→claim→result→heartbeat→wake-on-comment→approvals→budget→trust machinery, makes Claude Code a genuine fleet executor (watchdogs, timeline, pause/terminate all apply), and matches the **north-star Paperclip adapter model** (`docs/TRD-paperclip.md:26` names "Claude Code" as a pluggable adapter; §5.5's `claude_local` is the direct analogue).

**Option B — formalize a `start_code_task` orchestrator tool as an agent identity.** Give Arturita/the orchestrator a tool that registers a Claude Code agent identity and kicks a coding session. This is **net-new with no reusable base** (no such tool exists) and still needs a host process to actually run `claude`. It collapses into Option A: once the adapter exists and the identity is registered, "the office assigns a task to the Claude Code agent" *is* the trigger — no separate dispatch tool needed. **Recommendation: build A; skip B**, or implement B later as thin sugar (an orchestrator `[DELEGATE: ClaudeCode | …]` already works via the existing delegation path once the agent exists).

---

## 4. Reused vs. net-new inventory

| Concern | Status | Where |
|---|---|---|
| `claude_code` runtime value | ♻️ **reused** — accepted everywhere | schema `:59`, `agents.ts:348`, `hiring.ts:4`, `onboard.mjs:8`, wizard `:14`, badge `shared.tsx:39`, `RUNTIME_BRANCH` `agent-api.ts:15` |
| Registration + token mint/rotate | ♻️ reused | `agents.ts:344-387`, `agent-token.ts` |
| Onboard CLI (`--runtime claude_code`) | ♻️ reused | `cli/onboard.mjs`, `cli/mc.mjs` |
| Assign → notify external path | ♻️ reused | `agent-executor.ts:59-73`, `agent-runtime.ts:33-48` |
| Task queue / claim / lock / session-resume | ♻️ reused | `agent-api.ts:305-378` |
| In-thread comments / attachments / result | ♻️ reused | `agent-api.ts:205-241`, `:381-421` |
| Heartbeat + freshness + fleet render | ♻️ reused | `agent-api.ts:295-302`, `agent-runtime.ts:14-28`, `AgentFleet.tsx` |
| Workspace worktree + `cc/` branch | ♻️ reused | `agent-api.ts:318-327`, `workspaces.ts:11-34` |
| Approvals / run-token / secrets endpoints | ♻️ reused | `agent-api.ts:257-264`, `:101-106`, `:424-433` |
| **Host Claude Code adapter (poll loop + `claude -p`)** | 🆕 **net-new** | `adapters/claude-code/` (template: `openclaw/mc_adapter.py`, `cursor/cursor_adapter.py`) |
| **`HireDialog`/wizard `claude_code` adapter branch + env profile** | 🆕 net-new (small) | `HireDialog.tsx:40-45`, `AddAgentWizard.tsx:38` |
| **Secure-by-default registration for code-executors** | 🆕 net-new (small) | `agents.ts:358-376` (set `trustMode:'low_trust_review'`, explicit `permissions`, `trustBoundary`) |
| **Command allowlist/denylist for `claude` shell ops** | 🆕 net-new (gap) | see §5.2 |
| `start_code_task` orchestrator tool (Option B) | 🆕 net-new — **not recommended for MVP** | — |

---

## 5. Safety model

Giving the office a lever to run code on a host is the whole risk. The good news: the existing guardrails already form a 9-gate chain that a `claude_code` executor passes through **for free** — the design must *configure* them correctly and close two gaps, not build a new safety system.

### 5.1 The existing gate chain (applies to any external run)
Order a run traverses (`agent-executor.ts` + adapters):
1. **`canAgentRun` status gate** — paused/terminated agent never runs (`governance.ts:4-10`, enforced `agent-executor.ts:41-46`; `/panic` and budget breach both set `paused`).
2. **Scoped budget hard-stop** — breach pauses the agent *and* parks its queue (`budget.ts:56-78`, `agent-executor.ts:48-57`).
3. **Per-wake preflight cost cap** — parks the single run if worst-case cost > cap (`preflight.ts:69-105`, `agent-executor.ts:100-115`).
4. **Daily / monthly / concurrency limits** (`middleware/ratelimit.ts`, `agent-executor.ts:126-128`).
5. **Low-trust review (P1)** — for a `low_trust_review` agent, any resource outside `trustBoundary` is hard-**refused**; gated actions are **quarantined** for human approve/reject; stacks *in front of* A2 and never bypasses step-up (`services/review.ts:193-236`, decide route `tasks.ts:455`).
6. **Capability check** per side-effect (`isCapabilityAllowed`, `governance2.ts:21-26`) — ⚠️ **allow-all when empty** (see gap 1).
7. **A2 approval + step-up** for the `machine_exec` / destructive danger classes — the human sees the **verbatim `argv`** (not a shell string, not model prose) and must **re-authenticate a fresh session** before approving (`dangerous-approvals.ts:17-23`, `:136-187`, `tasks.ts:446-475`).
8. **Run-token** — 15-min HMAC scoped to `{agentId,orgId,runId}` (`governance2.ts:31-49`).
9. **Host daemon** (prior art `adapters/arturita-host/`) — localhost-only + bearer token, path **denylist** (`.ssh`, `.aws`, `.gnupg`, keystores, `.env`, wallets…), system-integrity prefixes, symlink-escape checks, blast-radius caps, destructive ops fail-closed behind `approved===true`, undo journal (`adapters/arturita-host/src/safety.mjs`, `actions.mjs`; backend twin `services/host-planner.ts` with master switch `HOST_EXECUTION_ENABLED=false`).

### 5.2 What MUST gate a Claude-Code executor (requirements)
- **R1 — Register secure-by-default.** A code-executor must be created with `trustMode:'low_trust_review'` and a **narrow `trustBoundary`** (its project/workspace/task set), so out-of-scope work is refused and in-scope gated actions are quarantined. *(Gap: the create endpoint currently defaults to standard/allow-all.)*
- **R2 — Explicit non-empty `permissions`.** Because `permissions == null/[]` means allow-all (`governance2.ts:22`), a code-executor must be given an explicit capability list (e.g. `memory:write`, `attachment:write`, and a new `machine_exec` capability). An empty list is a footgun here.
- **R3 — Route every code/shell action through the A2 `machine_exec` gate**, rendering the verbatim `argv` + step-up. The headless `claude` run must surface intended shell commands as approval requests, not execute them silently. Destructive file ops go through the host-daemon fail-closed `approved===true` path.
- **R4 — Command allowlist/denylist (build this).** ⚠️ **Gap:** today there is *no* shell-command semantic denylist (`rm -rf`, `curl|sh`, etc.). Command control rests only on the `machine_exec` approval + the daemon not yet exposing an exec endpoint (`arturita-host/src/server.mjs:9-11`, "machine_exec … intentionally NOT exposed yet — C3"). A Claude Code executor that can run commands needs a command allowlist/denylist layer — this is the single biggest new safety surface. Until it exists, keep the adapter in a **plan-and-approve** mode (propose `argv` → A2 → daemon), never free exec.
- **R5 — Budgets + preflight caps configured per-agent** (`maxCostPerWakeUsd:<agentId>`, scoped `budget_policies`), so a runaway coding loop self-limits.
- **R6 — Scope the run-token / secrets** to what the task needs; the daemon binds localhost + bearer only.

**Net safety posture:** with R1–R3, R5–R6 (all *configuration* of shipped machinery) a Claude Code executor is already well-contained for read/plan/propose work. R4 (command denylist) is the one genuinely new control required before enabling autonomous shell execution — so the MVP ships in propose-and-approve mode and R4 unlocks broader autonomy later, mirroring the Arturita C1→C3 progression.

---

## 6. Build plan (stories, mapped to conventions)

New **Epic CC — Claude Code engineering agent** (one PR per story, squash-merge `--admin`, `npm test` + `npm run evals` green before merge). Tracked in `docs/PLAN-arturita.md` §0.

| Story | Scope | Acceptance |
|---|---|---|
| **CC1** · Claude Code adapter (poll loop) | `adapters/claude-code/` daemon mirroring `openclaw/mc_adapter.py`: onboard as `runtime:'claude_code'`, poll `/tasks?state=assigned`, claim, run **headless `claude -p`** in the workspace/worktree, stream `/runs/:id/log`, post `/result` + `/heartbeat`. Stdlib/zero-dep per `adapters/CLAUDE.md`. | An assigned task is claimed, a headless Claude run executes in `MC_WORKDIR`, logs stream to the thread, result posts back, heartbeat goes green. `--once` smoke path. |
| **CC2** · Propose-and-approve `machine_exec` bridge | Adapter surfaces intended shell/destructive ops as A2 `machine_exec` approvals (verbatim `argv` + step-up); destructive file ops via the host-daemon fail-closed path. No free exec. | A command intent creates a pending approval; run blocks until decided; denied → not executed; approved (fresh session) → executed + audited. |
| **CC3** · Secure-by-default registration | Create endpoint (or a `claude_code` branch of it) sets `trustMode:'low_trust_review'`, explicit `permissions`, and a `trustBoundary` from the target workspace/project. New `machine_exec` capability string. | A Claude Code agent registers contained; out-of-boundary work refused; empty-permissions footgun closed for this runtime. Unit tests on the trust/capability defaults. |
| **CC4** · UI/CLI adapter wiring | `HireDialog.tsx:40-45` + wizard `mc.env` get a `claude_code` adapter branch/profile pointing at `adapters/claude-code/`; optional `externalEndpoint` field in the wizard. | Hiring/adding a Claude Code agent prints the correct adapter run-command + env, not the OpenClaw one. Web tests for the branch. |
| **CC5** · Command allowlist/denylist (unlock autonomy) | Build the missing semantic command control (R4): per-agent allowlist + global denylist for `claude` shell ops, integrated with the `machine_exec` render (`allowlisted` flag already exists at `dangerous-approvals.ts:136-145`). | Denylisted commands are refused pre-approval; allowlisted safe commands can run without step-up per policy; everything else stays A2-gated. Backend tests. |
| **CC6** · Docs / DX / go-live | `adapters/claude-code/README.md`, update `adapters/CLAUDE.md`, `GO-LIVE.md` prereqs (Claude CLI installed, token, workboundary), `STATUS.md`, vault milestone. | Operator can bring a Claude Code agent up from zero; go-live gates documented. |

**Sequencing:** CC1 → CC2/CC3 (parallel) → CC4 → CC5 (unlocks autonomy) → CC6. MVP = CC1–CC4 in **propose-and-approve** mode; CC5 gates broader autonomy.

---

## 7. Open questions / partial sections

- **Headless invocation contract** — exact `claude` headless flags (`-p`, `--output-format stream-json`, session/resume, tool-permission mode) need a spike in CC1; treat the diagram's flags as indicative, not final. *(Partial — implementation detail, not a feasibility blocker.)*
- **Authentication of the `claude` process itself** — the host adapter needs Claude Code credentials on the host (separate from the `mca_` MC token). Per `adapters/CLAUDE.md` the live adapter host is off-limits without asking; onboarding a Claude Code agent must not touch the existing OpenClaw adapter install.
- **One-identity-per-checkout** — `docs/Claude-Config-and-Architecture-Review-2026-07-02.md:59-65` proposes syncing a single `agents/<name>.md` to drive *both* a Claude Code session and its MC runtime identity; worth adopting so the agent's persona/ToR is consistent across both.
- **Option B (`start_code_task` tool)** — deliberately deferred; the delegation path (`[DELEGATE: ClaudeCode | …]`) already gives the orchestrator a trigger once the agent exists.

---

## 8. Verdict recap

Claude Code can join the office as a first-class engineering agent **now**, mostly by reuse. The office already models it as a runtime with identity, onboarding, task threads, workspaces (`cc/` branches), heartbeat, approvals, budgets, and trust. The shortest path is **one host adapter (CC1)** in propose-and-approve mode, plus small UI/CLI wiring (CC4) and a secure-by-default registration flip (CC3). The one genuinely new safety control — a command allowlist/denylist (CC5) — gates the step from "propose + human-approve" to "autonomous shell execution," exactly mirroring the shipped Arturita host-daemon progression.
