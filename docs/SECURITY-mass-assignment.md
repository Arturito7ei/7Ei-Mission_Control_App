# The mass-assignment / gate-order class (GC-0, GC-0b)

> Nine routes in this repo shipped the same defect. This note exists so there is no tenth.
> Enforced by `backend/src/tests/gc0b-mass-assignment-guard.test.ts` — a static scan, not a convention.

**The class has two legs.** Getting only the first is how instances #7–#9 survived the first fix:

| Leg | Shape | Consequence |
|---|---|---|
| **(a) UPDATE** | body-writable **tenant column** (`orgId`) | the row walks into another tenant |
| **(b) CREATE** | body-supplied **org-scoped reference** that is later **executed** | another tenant's *agent* runs, under *their* credentials |

Leg (b) is the one that hides, because on a create route `orgId` comes from the **path** —
correct, gate-checked, obviously safe — and that is exactly what makes the foreign key
beside it read as harmless. See "The create-path leg" below.

## The shape

```ts
app.patch('/api/x/:id', async (req) => {
  await db.update(schema.x).set(req.body as any).where(eq(schema.x.id, id))
})
```

The raw request body written into a row: no parse, no field allow-list. Every column of
`x` is now client-writable, including the ones that decide **who owns the row** and
**what the row is allowed to do**.

## Why the membership gate does not save you

This is the part that made the bug survive six code reviews.

`resolveRequestOrg` (`backend/src/middleware/rbac.ts`) derives the org a request targets.
For a top-level record route it derives it **from the row** — the `RECORD_ORG_ROUTES`
prefix table, or the `:agentId` / `:taskId` branches — and it reads that row **before**
the handler runs.

So the sequence is:

1. Gate loads the row. Row says `orgId = A`.
2. Caller is genuinely a member of A. **Gate passes, correctly.**
3. Handler writes `orgId = B`.

**A gate that authorises against the pre-image cannot defend a field that rewrites the
pre-image.** The check was not bypassed and was not wrong; it answered a question that
stopped being true one line later. No amount of gate hardening fixes this — the tenant
boundary has to live in the write path, as an allow-list.

There is a second variant with the same root cause and no ordering involved: a route
whose org comes from the **path** (`/api/orgs/:orgId`) has no ordering bug at all, but a
body-spread still lets a caller write columns that are **owner-gated on a sibling route**.
That is `PATCH /api/orgs/:orgId`, instance #6 — a plain member could overwrite the org's
plaintext LLM API keys.

## The rule

**Allow-list. Never deny-list.**

```ts
const XPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
})   // ← NOT .strict(): unknown keys are STRIPPED, so a whole-object round-trip
     //   still succeeds; it just cannot move the row.

const parsed = XPatchSchema.safeParse(req.body ?? {})
if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message })
const patch = parsed.data
if (Object.keys(patch).length > 0) {
  await db.update(schema.x).set(patch).where(eq(schema.x.id, id))
}
```

A deny-list is what `PATCH /api/agents/:agentId` had. It deleted exactly one key
(`permissions`) and shipped a member-settable `trustMode` — which governs whether a
connector write needs human approval (CONN-7). Every column the author did not think of
stayed open. **The failure mode of a deny-list is silence:** add a column to the table
later and it is writable, with no diff to review.

### What is never writable

| Field | Why |
|---|---|
| `orgId` | The tenant boundary. **Both directions** — `null` on a taggable table promotes a row into the global/shared space. |
| `id` | Identity. Rewriting it orphans every child row. |
| `createdAt` | Immutable provenance, and an audit-ordering input. |
| Credentials | `apiTokenHash`, `deployConfig`, `telegramBotToken` — have dedicated owner-gated routes. |
| Metering / locks | `costUsd`, `tokensUsed`, `lockToken` — server-owned; client-writable spend evades the budget cap. |
| Sync provenance | `source`, `githubPath` — `githubPath` is the sync JOIN KEY; writing it re-points what overwrites the row next sync. |
| **Anything owner-gated on a sibling route** | Otherwise the two surfaces disagree and the member-gated one wins. |

That last row is the one people miss. Before adding a field to an allow-list, grep for a
`requireOrgRole('owner')` route that already writes it.

## The create-path leg (instances #7–#9)

```ts
POST /api/orgs/ORG-A/tasks   { "agentId": "<an agent in ORG B>" }
```

The task is correctly created in org A. Then `executeAgentTask` resolves the agent **by
id alone** and treats `agent.orgId` as ambient authority — org B's LLM credentials,
budget, knowledge base and connectors — while the output lands in a row org A can read.
No tenant column was ever rewritten, so nothing that looks for leg (a) can see it.

`POST /api/orgs/:orgId/scheduled` was worse: cron re-executes it indefinitely, **and**
the route mints a webhook token whose trigger endpoint is registered *outside* the
authenticated scope — so the URL fires the victim's agent with no session at all, and
keeps working after the attacker leaves their own org.

### Two layers, deliberately

1. **Per-route (ergonomic).** `assertAgentInOrg(agentId, orgId)` from
   `services/tenant-guard.ts`, returning a message or `null`. 400s at CREATE so the bad
   row never exists and the operator gets a real error. **Run it before any integration
   -config check** (`if (!cfg) return 'not connected'`) — behind one, the guard is
   skipped for orgs without that integration and runs only in production. Our own
   ordering test caught exactly that.
2. **In the executor (authoritative).** `executeAgentTask` refuses when
   `task.orgId !== agent.orgId`, marks the task `failed` / `needs_attention`, and bills
   nothing.

The invariant belongs to **execution**, not to any entry point — there are eight call
sites into the executor and six paths that create an executable row. Route checks are a
convention that has now failed three times; one check at the single point every
execution passes through is a total guarantee. Keep both: the route check gives a good
error, the executor check is the one that is actually load-bearing.

### Fail closed, and don't build an oracle

`assertAgentInOrg` refuses a **missing** agent identically to a **foreign** one, with
the same message. Distinguishing them tells an attacker whether an id exists in another
tenant.

## The nine instances

| # | Route | Severity | What it allowed |
|---|---|---|---|
| 1 | `PATCH /api/projects/:projectId` | High | Cross-org move (board + tasks follow) |
| 2 | `PATCH /api/goals/:goalId` | High | Cross-org move |
| 3 | `PATCH /api/skills/:skillId` | **Critical** | Any authed user **in no org** rewrites global-library `content` — prompt material fed to agents, i.e. instruction injection |
| 4 | `PATCH /api/agents/:agentId` | **Critical** | Cross-org move **+** member sets `trustMode: autonomous`, escalating into the CONN-7 connector gate |
| 5 | `PATCH /api/tasks/:taskId` | High | Cross-org move; `agentId` re-pointable at another org's agent |
| 6 | `PATCH /api/orgs/:orgId` | **Critical** | Deny-list; member overwrites `deployConfig` (plaintext LLM keys), `telegramBotToken`, `budgetMonthlyUsd` |
| 7 | `POST /api/orgs/:orgId/tasks` | **Critical** | *(leg b)* Body `agentId` → another org's agent executes, on their credentials |
| 7b | `POST /api/orgs/:orgId/scheduled` | **Critical** | *(leg b)* Same, on **cron**, plus an **unauthenticated** webhook trigger URL |
| 8 | `POST /api/orgs/:orgId/jira/sync` | **Critical** | *(leg b)* Imports a whole backlog as executable tasks on a foreign agent |
| 9 | `POST /api/orgs/:orgId/jira/issues` | **Critical** | *(leg b)* Same, when the optional `agentId` is present |

Also closed alongside: `POST …/goals` (`ownerAgentId` — cross-tenant *reference*, not
execution) and `POST …/comms/inbox/send` (body `agentId` written to `messages`, which are
replayed as an agent's **conversation history** — a cross-tenant prompt-injection write).

**How each was found matters more than the list.** #1–#2 were reported. **#6** came from
sweeping for the *shape* rather than working the list. **#7** came from an auditor
noticing the class had a second leg the guard didn't scan. **#8 and #9 were found by the
widened guard itself, on its first run** — in a file nobody thought of as task-creating.
That is the argument for a mechanical check over careful reading.

### The skills special case

`RECORD_ORG_ROUTES` marks `/api/skills/` `nullOrgIsGlobal`, so for a row with
`orgId == null` the gate returns `{ scoped: false }` and **stands down entirely**. That is
correct for **reads** — the library is a deliberately global catalogue and `orgId` is a tag,
not a boundary — but it applied to writes too.

The rule now implemented: **a global skill is not editable or deletable through the API by
anyone**; its write path is sync (`POST /api/skills/sync`, `POST /api/skills/obsidian-sync`).
Raising the role instead was not an option: `requireOrgRole('owner')` reads `:orgId` from the
URL and **silently no-ops on a path without one** (the R-4 trap), and a global skill has no
org to be an owner of.

## Testing the fix

A guard that survives its mutant is worthless. Every suite here was **mutation-proven**:
revert the fix, watch a large fraction of the suite go red, restore.

**Per-test reset is mandatory.** Without it these suites are *vacuous*: the first test's
exploit moves the row into org B, so every later probe hits the membership gate, 403s, and
**passes for the wrong reason**. Two sessions hit this trap and it hid two Criticals. Each
suite therefore carries an explicit two-step tripwire — one test mutates, the next asserts
it sees a pristine row — so a broken `beforeEach` fails loudly instead of silently
greenwashing.

Cover, per route: the exploit at 200 before / blocked after; the 15 exotic shapes
(duplicate keys, case variants, snake_case, array- and object-valued tenant fields, `null`,
`__proto__`, `constructor.prototype`, whole-object round-trip); immutable columns; and a
"the guard is not a brick" test proving legitimate writes still land.

## The class-level guard

`backend/src/tests/gc0b-mass-assignment-guard.test.ts` statically scans every route module:

- **`.set(req.body)` / `.set(body)` → hard fail**, with the remediation in the message.
- **Any other non-literal `.set(...)` argument** must be listed in `REVIEWED_SINKS` with a
  one-line justification. A new opaque sink fails until a human writes down why it is safe.
- **Inline object literals** (`.set({ status, kanbanColumn })`) are self-evidently
  allow-lists and always pass, so the guard stays quiet enough to keep.

**Leg (b) — the create path.** A second scan requires that any handler reading an
executable org-scoped FK out of the **body** (`body.agentId`, `ownerAgentId`,
`targetAgentId`) calls `assertAgentInOrg`.

*The honest limit:* a regex pass **cannot** prove a given FK is later executed — that is
inter-procedural taint analysis (route → row → scheduler → executor) and this repo has no
infrastructure for it. What it **can** do is enforce a structural convention: the marker
must be present. That is the entire reason `assertAgentInOrg` exists as one shared named
function instead of three hand-rolled `if` blocks — a scanner can look for a name.

So the guard does not prove correctness; it proves nobody added a body-supplied agent id
without confronting the question. That is the review step that was missing when #7
shipped, and it is the most a scanner can honestly buy here. The **authoritative** defence
is the runtime invariant in `executeAgentTask`, which needs no marker and no scanner
because every execution passes through it.

Scope note: `projectId` / `goalId` / `parentTaskId` are deliberately **not** watched —
they can dangle a reference but nothing executes them, and a noisy guard is a deleted guard.

Verified to bite: planting instance #7 in `webhooks.ts` — both as a raw body **and** as the
subtler deny-list variant — fails the test in a route the guard had no prior knowledge of.
The create-path scan is proven the same way against a planted create shape, and it earned
its keep immediately: **it found #8 and #9 on its first run.**
