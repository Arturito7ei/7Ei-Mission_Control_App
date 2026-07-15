# AUDIT — ONB6 (create-invite UI · copy-able onboarding prompt · CLI)

> Independent code/security audit of Epic ONB **Stage 6** (PR #255, merged to `main` as `b6ed63f`).
> Auditor did not build ONB6. Scope: the operator-facing surface — the create-invite dialog, the
> one-time token/prompt reveal, the invite list/revoke, the join-request approval cards, and the CLI
> (`invite create` + `onboard --invite`). ONB1–ONB4 carried caveats reviewed for regression only;
> ONB5/ONB7 out of scope.
>
> **VERDICT: PASS-WITH-FIXES.** No high/blocker. One LOW fixed in this PR (CLI `mc.env` mode on
> overwrite). The operator surface of Epic ONB is sound: owner-gating is real server-side (not
> button-hiding), no claimed agent key reaches any UI, log, clipboard, or the DOM, and the four
> ONB invariants hold.

---

## Method

- Read the PR diff end-to-end: `InviteAgentDialog.tsx`, `invites.logic.ts`, `InboxSection.tsx`,
  `CockpitPanel.tsx`, `cli/invite.mjs`, `cli/mc.mjs`, and both test files.
- Traced every claimed backend gate to source: `routes/agent-invites.ts` (create/list/revoke +
  join/claim), `routes/tasks.ts:446` (the Inbox-card decide door), `middleware/rbac.ts`
  (`requireOrgRole`/`enforceOrgRole`), `services/onboarding-doc.ts:560` (`buildOnboardingPrompt`),
  `services/join-requests.ts` (`joinAcceptedResponse`, `buildJoinApprovalCard`),
  `services/agent-invites.ts:252` (`inviteView`), `services/deployment-profile.ts:169`
  (`operatorCanSeeClaimedKey`).
- Ran the invariant: **CLI 15/15 · web 186/186 · web build ✓**. Backend is untouched by ONB6
  (0 backend files in the diff), so the 1221-test backend suite is unchanged.

---

## Findings by severity

### HIGH / BLOCKER — none.

### MEDIUM — none.

### LOW

**LOW-1 — `mc.env` chmod-600 guarantee is not enforced on overwrite. _(FIXED in this PR)_**
`cli/mc.mjs` — agent-side `onboard --invite`, the `mc.env` write.
`writeFileSync(cfg.out, …, { mode: 0o600 })` applies `mode` **only when the file is created**. If
`mc.env` already exists — a second onboard run, or a world-readable file another tool left at
`./mc.env` — `writeFileSync` truncates and writes the fresh `mca_` agent token but **keeps the
existing permissions**, silently defeating the design's "chmod-600 `mc.env`" property (DESIGN §3.8,
invariant #5) that the success message itself asserts ("wrote mc.env (chmod 600)").
*Failure scenario:* on a shared host, `touch mc.env` (mode 644) → `7ei-mc onboard --invite …` →
the agent token lands in a world-readable file while the CLI reports it as 600.
**Fix applied:** `rmSync(cfg.out, { force: true })` before the write, so the `0o600` mode is applied
atomically at creation with no exposure window. Local-only, agent-side, does not touch the backend,
any invariant, or `allowShell`.

### NIT

**NIT-1 — `CopyButton` reports "✓ Copied" even when `navigator.clipboard` is absent.** _(not fixed —
noted)_ `InviteAgentDialog.tsx:37` — `navigator.clipboard?.writeText(value)` is optional-chained, so
on a context without the Clipboard API the write is a no-op yet the button still flips to "✓ Copied".
Because the invite token and prompt are shown **once and are not recoverable**, a false success is
marginally worse here than in a normal copy affordance. Very low likelihood in practice (app.7ei.ai
is HTTPS, where the API is present), and the raw token/prompt remain visible in the token box and the
`<pre>` for manual selection, so no data is actually lost — hence NIT, not LOW. A guard that only
flips state inside a resolved `writeText()` (or falls back to text selection) would close it. Left to
the builder to keep this audit's diff minimal.

**NIT-2 — CLI `invite create` does not bound `--uses`/`--ttl-hours` to the registry maxima.**
`cli/invite.mjs:42-47` validates positivity but not the ceilings (`MAX_MAX_USES=50`,
`MAX_INVITE_TTL_HOURS=168`) that the web `validateCreateInvite` enforces client-side. Defensible —
the backend Zod schema (`agent-invites.ts:44`) is the authority and returns a clean 400 — so this is
a cosmetic asymmetry between the two clients, not a hole. Noted, not fixed.

---

## Rulings on the builder's four flags

**Flag 1 — residual `adapterProfile.ts` client duplication for the manual run-block: acceptable
deferral to ONB7, or must-fix? → ACCEPTABLE DEFERRAL.**
The ONB6 invite picker reads the **server** registry (`GET /api/adapters` →
`pickableAdapters(invitable && available && kind!=='internal')`, `invites.logic.ts:27`), which is
exactly `joinableAdapterTypes()` on the server computed from the same payload — so the ONB1 audit's
"second source of truth" clause **is closed for the invite flow**. The residual
`web/lib/adapterProfile.ts` drives a *different* surface (the manual Add-Agent/Hire run-block) and
holds *different* data (the operator's local run-block env, not the `agentDefaultsPayload` contract);
it is neither dead nor a simple duplicate. It never feeds the invite path. Correct to defer; not a
must-fix.

**Flag 2 — owner-gating is server-side, not button-hiding: → CONFIRMED.**
Every write the dialog can trigger is gated at the route, independent of the button being visible:
- Create / list / revoke / posture: `requireOrgRole('owner')` preHandler on
  `/api/orgs/:orgId/agent-invites[...]` (`agent-invites.ts:115,166,178,199`). The route carries
  `:orgId`, so the `requireOrgRole` no-op-without-`:orgId` trap does **not** apply here
  (`rbac.ts:58` reads `req.params.orgId`).
- Join-request decision from the Inbox card (`InboxSection` `onDecide` → `POST
  /api/approvals/:id/decide`): that route has no `:orgId`, so it derives the org **from the approval
  row** and calls `enforceOrgRole` with `requiredRoleForApproval` — **owner** for
  `agent_join_request` (`tasks.ts:452-468`). This is the ONB3-H1 hardening ("both doors"), and it is
  route-tested: `onb3-approval-gate.test.ts` asserts a **member → 403** on deciding a join card.
- The dedicated owner routes (`/api/orgs/:orgId/agent-join-requests/:id/{approve,reject}`) funnel
  through the **same** `applyJoinDecision`, so the Inbox door and the API door cannot drift.
The dialog being visible to all operators is therefore purely cosmetic; a non-owner is refused at the
server for create, revoke, and approve alike.

**Flag 3 — `onboard --invite` uses a flat-404 as the pending poll signal: → ACCEPTABLE.**
The agent-side poll loop (`mc.mjs:190-195`) treats any non-`ok` claim response as "still waiting" and
retries until `--max-wait`. This is forced by, and consistent with, the epic's deliberate no-oracle
posture: the claim endpoint collapses *every* failure (unapproved · expired · wrong secret ·
already-claimed · lost race) to one identical 404 (`agent-invites.ts:441-453`), so the CLII **cannot**
be more discerning than the endpoint permits, and it should not try. The give-up message is honest
about the ambiguity ("not approved (or the claim secret expired)"). The only cost is that an expired
secret wastes poll cycles until the deadline — an acceptable price for denying an attacker a status
oracle.

**Flag 4 — hosted keeps join/claim at 404, so the agent-side flow is planner-tested only: → NOTED
(coverage gap, not a blocker).**
On the live hosted backend `MC_ENABLE_REMOTE_ONBOARDING` is false, so join/claim answer 404 and the
`onboard --invite` round-trip cannot run against prod. The **pure planners** are unit-tested
(`joinRequestPlan`, `claimRequestPlan`, `mcEnvLines` — `cli/test/invite.test.mjs`), and the **server**
flow is tested with the posture forced open (`e2e-onboarding`, `onb4-claim`, `onb3-join-flow`). What
is **not** covered by any automated test is the `mc.mjs` IO glue itself — `runAgentOnboard`'s
join→poll→claim→write sequence. I independently verified the field contract by hand:
`joinAcceptedResponse` returns `requestId` + `claimSecret` and the claim route returns `token`
(`join-requests.ts`, `agent-invites.ts:458`), and the CLI reads exactly those keys
(`mc.mjs:176,177,192`) — so the glue *is* wired correctly, but that correctness rests on a manual
read, not a test. **Recommendation (ONB5/ONB7, before remote onboarding is enabled in prod):** an
integration test that spins the server with the posture open and drives the CLI end-to-end. Non-
blocking for ONB6, whose acceptance target (the operator's one-paste create flow) is fully exercisable
today.

---

## Verified clean

- **No claimed agent key anywhere in the operator surface.** The create response and the reveal UI
  carry only the invite token + onboarding prompt + doc URL (`InviteAgentDialog.tsx:100-131`);
  `buildOnboardingPrompt` embeds *only* the invite token via the doc URLs, never a credential
  (`onboarding-doc.ts:560`); `inviteView` returns neither the token nor its hash
  (`agent-invites.ts:252`); the reveal copy says so out loud ("There is **no agent key here**").
  `operatorCanSeeClaimedKey` is a literal `false` (`deployment-profile.ts:169,248`) and is
  test-locked in four places.
- **CLI leaks no credential.** `invite create` prints the invite token + prompt once and has no code
  path that could surface a claimed key (`mc.mjs:136-145`); `onboard --invite` writes the `mca_`
  token to the file and **never** echoes it — every error/give-up branch prints only status text, and
  the join/claim response bodies that *do* carry secrets (`claimSecret`, `token`) are consumed into
  variables, never logged (`mc.mjs:174-207`). The dry-run prints the join **plan**, which carries no
  secret.
- **Clipboard payloads are exactly the intended one-time invite data** — token, doc URL, prompt
  (`CopyButton` call-sites `InviteAgentDialog.tsx:120,121,128`). Nothing else reaches the clipboard.
- **`mc.env` carries no LLM key.** `mcEnvLines` writes only `MC_BASE_URL`/`MC_AGENT_TOKEN`/
  `MC_WORKDIR` + a non-secret adapter comment; a test asserts `doesNotMatch(/LLM|API_KEY/i)`
  (`cli/invite.mjs:126`, `invite.test.mjs:71-78`) — the standing `adapters/CLAUDE.md` rule.
- **Adapter picker renders only invitable + available, never internal** (`pickableAdapters`,
  `invites.logic.ts:27`; test `invites.logic.test.ts:18`).
- **Colorblind-safe status.** `inviteStatusChip` and `joinRequestChip` return **icon + label** +
  tone (never colour alone); the Inbox join chip is `🤝 Agent wants to join`
  (`invites.logic.ts:36,101`; `InboxSection.tsx`). Test asserts icon+label non-empty.
- **No raw hex in the new UI.** `InviteAgentDialog.tsx`/`invites.logic.ts` use `tk.*` tokens and
  `var(--…)` only; every referenced var (`--warn`, `--warn-bg`, `--accent-dim`, `--warning-dim`,
  `--warning-text`) is defined for both light and dark in `tokens.ts`.
- **Approval-card injection (R8) surfaced honestly.** The Inbox renders the machine-generated
  `summary` + `warnings` (`buildJoinApprovalCard`, `join-requests.ts:231-267`) with agent-supplied
  values under `selfDeclared` and labelled "self-declared, unverified"; the summary embeds
  `agentName` only as React text content (auto-escaped, length-capped at the join route).
- **Invariants hold.** The four ONB defaults, the posture/landmine guards, `claude_code` plan-mode,
  and the `PUBLIC_JOIN`/`TOKEN_CLAIM` constants are untouched by ONB6 (no backend diff). The public
  join/claim surface remains 404 on the hosted profile.

---

## Tests / main-green

- CLI **15/15** (7 onboard + 8 invite), web **186/186**, web build **✓**. Backend unchanged (0
  backend files in the ONB6 diff) → 1221 backend tests + 11/11 evals stand as merged.
- The LOW-1 fix touches `cli/mc.mjs` IO only (no pure function), so no test change is required; CLI
  suite re-run green after the fix.

---

## Bottom line

Epic ONB's operator surface — the whole point of the epic, "onboard an external agent by pasting one
prompt" — is **sound and shippable**. The credential-containment story survives contact with the UI
and the CLI: the operator can create, list, revoke, and approve, and at no point does a claimed agent
key touch a screen, a log, the clipboard, or a file the operator controls. Owner-gating is enforced at
the server on both the dedicated routes and the Inbox card door. The one real gap was a local file-
permission subtlety on the agent side, now fixed. Remaining items are a NIT and a test-coverage note
for ONB5/ONB7.
