# Handover — 2026-07-18 (status-synced 2026-07-19)

> Read this cold after a reboot to know where things stand. Companions: `STATUS.md` (the full
> shipped log), `HANDOFF.md` (session kickoff + verification), `GO-LIVE.md` (console actions),
> `docs/SECURITY-mass-assignment.md` (the security class, in full).

**Session status as of 2026-07-19.** `main` is green at `17f172e` (Test, CI and Deploy all
success); every requested story is merged and nothing is in flight. Next priorities, in order:
the **operator hardening trio** — branch protection on `main`, clearing the red `npm audit`, and
the operator credentials including `ALLOWED_ORIGINS` (all under OPEN OPERATOR ACTIONS below) —
then **GC-2, thread persistence**, because chat history in the Command Center still dies on
refresh and it is the most user-visible gap left.

**Where main is:** `17f172e` — `docs: a cold-start handover for after the reboot`, on top of
`b164184` — `fix(FIX-1): four defects a live visual pass caught and the suite could not (#336)`.
CI, Test and Deploy are all green on it. `https://7ei-backend.fly.dev/api/health` returns 200,
`db: connected`, scheduler running, version 1.3.0.

**Visual verification — DONE for web.** A live read-only Chrome pass against app.7ei.ai after the
FIX-1 deploy confirmed all four fixes are live and correct: the memory-brain graph renders
(**153 notes / 119 links**, not the old "0 notes"); Inbox and Activity no longer contradict —
queued tasks read **"Queued"**, and the Inbox's "nothing needs a decision" is consistent with it;
Activity's audit noise collapses into expandable **"N routine audit events"** rows and audit rows
read human-readably (`POST arturita › converse`) instead of raw UUID URLs; and the agent picker
renders with its full label plus a dropdown caret. This gap is **closed for web**.
**Mobile screens remain visually unverified** — no simulator run has been done. That caveat stands.

**Suites, re-run locally at `b164184` on 2026-07-18:**

| Suite | Result |
|---|---|
| backend `npm test` | **1873 / 1873** pass, 163 suites, 0 fail |
| backend `npm run evals` | **11 / 11** scenarios |
| backend `npm run typecheck` | clean |
| web `npm test` | **329 / 329** pass |
| web typecheck + production build | clean |
| apps/mobile `npm test` | **357 / 357** pass |
| apps/mobile typecheck + `npm run export` | clean (iOS bundle 4.17 MB) |

That is 2,559 tests green across the three workspaces.

---

## What shipped today

**Per-agent Connectors (the epic).** CONN-1 through CONN-9 took connectors from nothing to an
agent invoking them mid-run. Backend and the custom-MCP end-to-end path first, then the web
accordion and its mobile mirror, then real providers: GitHub PAT and Jira basic auth
(`adf06b3` #313), per-agent Google OAuth for Calendar/Gmail/Drive (`f2a3b08` #314), and
Telegram / WhatsApp / Google Chat comms (`9e02d8c` #315). CONN-7 (`a7c7d90` #317) added the
containment layer — capability plus per-connector trust plus approval and step-up enforcement.
Then execution: the framework and the GitHub executor (`63f9d9c` #319), Jira and comms
executors (`c2e3235` #320), the real Google Workspace executor (`4548339` #321), the custom-MCP
invocation bridge with DNS-pinned SSRF egress (`0d65c2c` #322), and the owner-facing execution
monitor on web and phone (`5830ed3` #323). CONN-9 (`27baa8f` #324) wired it into the agent loop —
gated by CONN-7, with injection containment.

Two things about this epic are worth carrying forward. Connector capability is enforced at **two**
layers, and removing either one alone changes nothing observable — so a test that proves one must
hold the other intact or it reads as vacuous when it isn't. And `workMode: 'ask'` routes to the
lean executor path, where the agent can talk but cannot act; any CONN-7 assertion written against
ask-mode is vacuous by construction.

**Mobile parity.** Every UI story above shipped its phone mirror in the same PR or the next.
The standing rule held all day. `apps/mobile` stays on Expo SDK 54 — that is the App Store Expo Go
ceiling, not a version we are behind on.

**The memory graph.** MEM-1 (`915f875` #327, audit `328`) turned the memory brain into a real
rendered graph — operable, bounded, theme-correct, on web and phone.

**Inbox and Activity.** ACT-1 (`bb18866` #329, audit `330`) made the Inbox show the latest
approvals and turned Activity into a genuinely unified log — `GET /orgs/:orgId/activity` merges
six sources behind one query builder shared by the desk and the phone. Owner-only kinds
(`connector_execution`, `audit_event`) are dropped per-caller before any query runs, never widened.
Alongside it, APPR-1 (`c31a4ec` #325) fixed a desk that *lied about approving* — it cleared the card
before awaiting and swallowed the 403, so a refused approve rendered as success.

**The agent picker.** GC-1 (`4c2fb9e` #335) — the Command Center now knows who you are talking to.

**The security sweep.** GC-0 (`fae2d37` #331) and GC-0b (`c44be4e` #333) closed nine instances of
one authorization flaw. Its own section follows.

**FIX-1** (`b164184` #336) closed four defects found by five minutes of looking at the live site.

---

## The security class

Nine routes shipped the same defect. `docs/SECURITY-mass-assignment.md` is the full write-up;
this is the shape of it.

**Leg (a) — gate order, on UPDATE.** `resolveRequestOrg` derives the org a request targets by
reading the row, *before* the handler runs. So: the gate loads the row, the row says org A, the
caller really is a member of A, the gate passes — correctly — and then the handler writes
`orgId = B`. A gate that authorises against the pre-image cannot defend a field that rewrites the
pre-image. The check was never bypassed and was never wrong; it answered a question that stopped
being true one line later. No amount of gate hardening fixes this. The tenant boundary has to live
in the write path.

**The deny-list leg.** `PATCH /api/agents/:agentId` deleted exactly one key (`permissions`) and
shipped a member-settable `trustMode` — which governs whether a connector write needs human
approval. Every column the author didn't think of stayed open, and the failure mode of a deny-list
is *silence*: add a column to the table later and it is writable, with no diff to review. The rule
is allow-list, never deny-list, and not `.strict()` — unknown keys get stripped so a whole-object
round-trip still succeeds, it just cannot move the row.

**Leg (b) — CREATE.** This is the one that hid. On a create route `orgId` comes from the path,
which is correct and gate-checked and obviously safe — and that is exactly what makes the foreign
key sitting next to it read as harmless. `POST /api/orgs/ORG-A/tasks` with an `agentId` belonging
to org B creates the task correctly in A, then `executeAgentTask` resolves the agent by id alone
and treats `agent.orgId` as ambient authority: org B's credentials, budget, knowledge base and
connectors, with the output landing where org A can read it. No tenant column is ever rewritten,
so nothing looking for leg (a) can see it. The scheduled-task variant was worse — cron re-runs it
indefinitely and it mints a webhook token whose trigger endpoint sits outside the authenticated
scope.

**The nine:** `PATCH` on `/projects/:projectId`, `/goals/:goalId`, `/skills/:skillId`,
`/agents/:agentId`, `/tasks/:taskId` and `/orgs/:orgId`; `POST` on `/orgs/:orgId/tasks`,
`/orgs/:orgId/scheduled`, `/orgs/:orgId/jira/sync` and `/orgs/:orgId/jira/issues`. Five of them
Critical. Closed alongside: `POST …/goals` (`ownerAgentId`) and `POST …/comms/inbox/send`, where a
body `agentId` was written to `messages` — rows that get replayed as an agent's conversation
history, making it a cross-tenant prompt-injection write.

**Where the fix lives.** Two layers, deliberately. Per-route `assertAgentInOrg` is the *ergonomic*
layer — it 400s at CREATE so the bad row never exists and the operator gets a real error. Run it
**before** any integration-config check, or the guard is skipped for orgs lacking that integration.
The **load-bearing** one is the runtime invariant in `executeAgentTask`: it refuses when
`task.orgId !== agent.orgId`, marks the task failed, and bills nothing. The invariant belongs to
execution, not to any entry point — there are eight call sites into the executor and six paths that
create an executable row. Route checks are a convention that has now failed three times; one check
at the single point every execution passes through is a total guarantee. Keep both.

**The class guard** — `backend/src/tests/gc0b-mass-assignment-guard.test.ts` — statically scans
every route module. `.set(req.body)` is a hard fail; any other non-literal `.set(...)` must be
listed in `REVIEWED_SINKS` with a written justification; inline object literals always pass so the
guard stays quiet enough to keep. A second scan requires that any handler reading an executable
org-scoped FK out of the body calls `assertAgentInOrg`.

**Its stated blind spot, which matters:** a regex pass *cannot* prove a given FK is later executed.
That is inter-procedural taint analysis and this repo has no infrastructure for it. What the guard
enforces is a structural convention — the marker must be present. It does not prove correctness; it
proves nobody added a body-supplied agent id without confronting the question. That is exactly the
review step that was missing when instance #7 shipped, and it earned its keep immediately: **the
widened guard found instances #8 and #9 itself, on its first run**, in a file nobody thought of as
task-creating.

---

## OPEN OPERATOR ACTIONS

These need the owner. Nothing here can be done from the repo.

**1. `OPENAI_API_KEY` on Fly — push-to-talk is dead without it.** Hosted STT exists and is
deployed; it returns 503 `not_configured` because there is no key. This is a *key* problem, not a
missing endpoint and not a dev-build problem. Live health confirms it: `"llm":{"providers":[]}`.

```bash
fly secrets set OPENAI_API_KEY='sk-...' -a 7ei-backend
```

**2. Google OAuth callback redirect URI.** Add this exact string in the Google Cloud console
credential, or CONN-5 / CONN-8b-2 cannot complete a flow (health currently shows `googleOAuth: 0`):

```
https://7ei-backend.fly.dev/api/agent-connectors/google/callback
```

**3. Per-agent connector credentials are entered in-app, not in Fly.** GitHub PATs, Jira basic
auth, and the Telegram / WhatsApp / Google Chat tokens are per-agent and encrypted at rest. They
live under each agent's Connectors tab. Do not put them in Fly secrets.

**4. `ALLOWED_ORIGINS` is `*` — the origin allow-list is effectively off.** Verified live today:

```
$ curl -i -X OPTIONS https://7ei-backend.fly.dev/api/health -H "Origin: https://evil.example.com"
access-control-allow-origin: *
access-control-allow-credentials: true
```

`*` together with `allow-credentials: true` is the combination to look at. Browsers refuse to
honour it for credentialed requests, so this is not an open door today — but it means the
allow-list is not doing anything, and the day something starts relying on it, it will not be there.

```bash
fly secrets set ALLOWED_ORIGINS='https://app.7ei.ai' -a 7ei-backend
```

**5. Branch protection is enabled on `main` (verified 2026-08-24).** Ten required status
contexts, `strict: true`, `enforce_admins: true`, `required_linear_history: true`,
`allow_force_pushes: false`, `required_conversation_resolution: true`. CI gates merge — a PR with
a failing required check stays `BLOCKED`. Do not rely on this doc for live protection config; use
`gh api repos/Arturito7ei/7Ei-Mission_Control_App/branches/main/protection`.

**6. A zombie Dispatch prompt needs dismissing on the device — not a code issue.** A
"Disconnected / Approve once" card recurs from the dead MOB-5a sessions. **Fully diagnosed:** it is
held in the **remote** Dispatch backend (`remoteSessionId cse_…`), not locally. The local side is
already clean — session records archived, `bridgeSessionIds` cleared, processes dead — and a full
app reboot did **not** clear it, which is the evidence that the survivor is remote. Approving never
works: the grant is single-use and needs a live process to consume it (see the zombie-session
diagnostic at the end of this file). **Resolution is operator-side on the device:** swipe the card
away, or toggle the Dispatch connection off and back on in the desktop app.

**7. `npm audit` checks are green on `main` (verified 2026-08-24 @ `570b1d8`).** Backend, web,
and `apps/mobile` audit steps all pass in CI. This item previously claimed five permanent
vulnerabilities in `drizzle-kit` / `form-data` — that state is stale; treat a future red audit as
a real signal again.

---

## Known-open follow-ups

**GC-2 — thread persistence.** Chat history in the Command Center is client-side `useState` and
**dies on refresh**. Deferred because GC-1 deliberately avoided a server-side provenance store;
adding one is the whole of GC-2, not a slice of it. This is the most user-visible gap on the list.

**GC-3 — Jira-backed project selector.** Shipped in #368 — picker binds to Jira projects,
selection persists in the GC-2 thread row.

**GC-4 — project-scoped retrieval.** Expensive: it needs a project dimension threaded through the
knowledge store *and* Pinecone. Deferred on cost, not on design.

**Owner-initiated connector trigger.** Connectors execute inside an agent run; the owner cannot
yet fire one directly. Optional follow-up from the CONN epic.

**stdio MCP execution.** Fail-closed *by design* — enabling it means spawning local commands on
the host. Only the http bridge shipped. Do not enable this casually; it is a deliberate posture,
not an oversight.

**The unauthenticated routine-webhook trigger endpoint needs a design review.**
`POST /api/routines/:token/trigger` (`backend/src/routes/scheduled.ts:105`) is registered outside
the authenticated scope and is reachable with the token alone. The GC-0b fix removed the
cross-tenant *escalation* through it, so it is no longer a vector for firing another org's agent —
but a bearer-token-in-a-URL design deserves a deliberate second look rather than inheritance.

**`/inbox` payload over-exposure — CLOSED, verified against main today.** GC-0 (`fae2d37` #331)
covers this exact route. Approvals are fetched as whole rows but never returned as such: they pass
through `toPublicApproval` (`backend/src/services/approval-public.ts:118`), an allow-list
projection of 10 named columns, sibling to `toPublicOrg`. Only `requiresStepUp` and `warnings`
survive from the payload blob — machine_exec argv, wallet destinations, email recipients and
connector params stay server-side, and `warnings` drops non-string elements rather than
stringifying them, so an `sk-live-…` cannot ride out inside one. Pinned by
`backend/src/tests/gc0-approval-projection.test.ts`, green in today's run. One honest note, not a
leak: `inboxCols` deliberately includes `output`, the agent-authored task text, shipped to any org
member for up to 300 tasks. Named field, intended, but it is the largest thing still crossing that
wire.

---

## Working rules that earned their place today

**Mutation-prove every guard.** Three Criticals hid behind fully green suites. The mechanism:
without a per-test reset, the first test's exploit moves the row into org B, so every later probe
hits the membership gate, 403s, and **passes for the wrong reason**. Two separate sessions reported
holes as safe on exactly that basis. Every suite now carries a two-step tripwire — one test mutates,
the next asserts it sees a pristine row — so a broken `beforeEach` fails loudly instead of quietly
greenwashing. A guard that survives its own mutant is worthless: revert the fix, watch the suite go
red, restore.

**Do a live visual pass after shipping UI.** Five minutes in Chrome against app.7ei.ai found four
defects that 2,800 tests structurally could not, because each was a property of what the operator
*reads*, not of what a function *returns*. The Inbox said "nothing needs a decision" while Activity,
one click away, badged six rows "Awaiting decision" — neither surface was wrong; one shared label
rendered both, turning routine queue depth into six phantom obligations. And note that **the fix for
one of the four introduced another**, caught only by a second pass. Ship, then look.

**Web ⇄ mobile parity.** Every UI change mirrors to `apps/mobile` in the same PR or the one straight
after. Say which of the three you did: mirrored, deferred to a named story, or N/A with a reason.
Metro cannot import from `web/`, so shared limits get hand-copied — always pin the copy with a test
that imports the web module and asserts they agree. A copy without a tripwire is silent drift.

**The two-step per-suite isolation tripwire** is the general form of the first rule and applies
beyond authz: any suite where test N's side effect could make test N+1 pass for a reason other than
the one under test needs an explicit assertion that the fixture is pristine.

A fourth, learned the same way: **a fixture sized smaller than the mechanism it tests proves the
mechanism helps, never that it suffices.**

---

## The zombie-session diagnostic

Two sessions died mid-turn two days ago and were archived today. Their signature is specific and
worth recognising immediately, because the intuitive response makes it worse.

**Symptom:** a Dispatch permission prompt marked **"Disconnected"** that re-queues forever.

**Why approving it can never work:** approval grants a *single use*, and that single use needs a
live process to consume it. If the session died mid-turn there is nothing left to consume the
grant — so the prompt returns, you approve it again, and it returns again. No number of approvals
resolves it. The prompt is a tombstone, not a request.

**The fix:** archive the session record and clear its `bridgeSessionIds` in

```
~/Library/Application Support/Claude/claude-code-sessions/<space>/<parent>/local_<id>.json
```

then **fully restart the app** — not just close the window.

**Updated 2026-07-19 — that local fix is necessary but not always sufficient.** If the card still
returns after all of it, the surviving record is **remote**, held in the Dispatch backend against a
`remoteSessionId cse_…`; the local cleanup has nothing left to remove and the reboot changes
nothing. At that point stop looking in the repo or the filesystem: dismiss the card on the device,
or toggle the Dispatch connection off and on. See operator action 6.

One of these two zombies is also what left the `adapters/cursor` work sitting dirty in this shared
checkout all day. Which points at the other lesson: **several sessions drive this one checkout.**
Use unique branch names, and verify a merge actually landed — an empty squash means you were
clobbered.
