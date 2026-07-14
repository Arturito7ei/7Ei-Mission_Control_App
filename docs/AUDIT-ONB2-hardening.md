# RE-AUDIT — the pre-ONB3 security hardening (PR #248)

**Scope:** an independent re-audit of PR #248, which closed the three ONB2-audit findings that had to land before ONB3 (`docs/AUDIT-ONB2.md` H-2, H-3, M-1) — the secured re-registration of the audit-log and trace query routes, the recursive `sanitizeBody`, the redacted telemetry span, the extended MCA-85 leak guard (`bootLikeIndex`), and the `[ONB2-H1]` tripwire.
**Auditor:** independent — did not build #248, and did not build ONB1/ONB2.
**Date:** 2026-07-14 · **Base:** `main` @ `0f66e5b`
**Method:** read `AUDIT-ONB2.md`, the full #248 diff, and the merged source (`middleware/audit-log.ts`, `services/telemetry.ts`, `services/log-redaction.ts`, `middleware/rbac.ts`, `middleware/clerk-auth.ts`, `src/index.ts`, `tests/auth-scoping.test.ts`, `tests/audit-onb2-fix.test.ts`, `services/adapter-registry.ts`). Grepped the whole monorepo (`web/`, `cli/`, `app/`, `backend/`) for callers of the two re-scoped routes. **Empirically probed** `sanitizeBody` against the adapter registry's real declared secret fields rather than trusting either the key list or the tests.

---

## VERDICT: **PASS-WITH-FIXES**

**The three prescribed fixes are sound.** Each does what it claims, each is proven by a test that would actually fail if it regressed, and the `[ONB2-H1]` tripwire is real. The fixer's restraint was correct: H-1 (enabling the trail) and `allowShell` are operator/product calls and were properly left alone, loudly, with a tripwire rather than a comment.

**But #248 solved H-2 and H-3 one layer short of the boundary, in the same way, twice** — it fixed the mechanism and left the *scope* of the mechanism at its old, too-narrow default:

- **H-2** moved `/api/traces` from *public* to *authenticated*. It is not tenant-scoped, and the span buffer is process-wide — so **any authenticated Clerk user could read every other org's span metadata.** A narrowing, not an isolation.
- **H-3** made `sanitizeBody` *recurse*, but left it deciding "is this key a secret?" by substring-matching a hand-written list. The **adapter registry** — which is what actually decides — declares `http_webhook.webhookAuthHeader` (`secret: true`, a bearer `Authorization` header value), and that name matches **none** of `key|token|secret|password|…`. **Confirmed by probe: it passed through into the row in plaintext.** The onboarding document instructs joining agents to send exactly that key inside `agentDefaultsPayload`.

Both are now fixed, with guards. Neither was dangerous *today* (the hook is still a no-op, ONB3 has not landed), and both would have gone live exactly when ONB3 + the H-1 decision made them matter — which is the same trap the original audit called out.

| Severity | Count | Status |
|---|---|---|
| Blocker | 0 | — |
| High | 1 (R-2, the registry/redactor drift) | **fixed here** |
| Medium | 1 (R-1, cross-tenant span metadata) | **fixed here** |
| Low / nit | 2 (R-3 clamp, R-4 rbac footgun) | 1 fixed, 1 documented |
| Operator/product | 2 (H-1, `allowShell`) | correctly still open |

**ONB3 is CLEAR TO START** once this lands. Nothing outstanding blocks it. The two open items (H-1, `allowShell`) are decisions, not defects, and neither is a precondition for writing the join route — the audit path is now safe-to-enable-by-construction *including* the two gaps #248 missed.

---

## VERIFIED CLEAN — the three prescribed fixes hold

**1. The audit surface is genuinely out of the public scope.**
`auditLogQueryRoutes` and `telemetryQueryRoutes` are split out of the hook plugins and registered inside the `secured` scope (`src/index.ts:142-143`), which carries the Clerk `onRequest` hook; the hook plugins themselves stay in the public block and now register **no routes at all**. `GET /api/orgs/:orgId/audit-log` additionally carries `preHandler: requireOrgRole('owner')` — and that gate is **real**, because the path has an `:orgId` for it to read (see R-4: this is not automatic). `audit-onb2-fix.test.ts:98` drives a real unauthenticated request and gets 401.

**2. The MCA-85 leak guard now covers the plugins — and this was the important half.** `bootLikeIndex()` registers `auditLogPlugin` + `telemetryPlugin` exactly as `src/index.ts` does, so a plugin-registered route can no longer hide from the guard. The blind spot that let H-2 through is closed at the source, not just at the symptom.

**3. `sanitizeBody` recurses correctly.** Objects and arrays, `SENSITIVE_KEYS` applied at *every* depth, every surviving string through `redactTokensInText` (wiring up NIT-1's orphaned helper). Verified against a nested `agentDefaultsPayload.apiKey` and a `headers['x-openclaw-token']`; non-secret siblings are preserved, so it is a redaction and not a bulldozer. The one subtlety is right: the `typeof value === 'string'` branch runs **before** the depth check, so a string is scrubbed at any depth, while an *object* past the cap is dropped whole.

**4. The telemetry span is redacted.** `redactPath(req.url)` feeds the span name, `http.url` and `http.route` — one helper (`services/log-redaction.ts`), every sink, no second implementation to drift. Proven end-to-end at `audit-onb2-fix.test.ts:113` with a real token through real routing: neither the token nor even the `mci_inv_` prefix survives.

**5. The `[ONB2-H1]` tripwire is real, not decorative.** It reads `index.ts` and asserts both plugins are still registered with a plain `await app.register(...)` and that `fastify-plugin` appears nowhere. Hoisting or wrapping the hooks — the two ways to enable the trail — fails the test. It is a genuine "you must make this decision consciously" gate.

**6. The restraint was correct and was executed honestly.** The trail records nothing, `GO-LIVE.md` §7 says so with the three options and the cost reasoning, `docs/API.md` says so on the endpoint itself, and `allowShell`/`MC_ALLOW_SHELL` is untouched. No silent enablement.

---

## FINDINGS

### R-2 (HIGH) — `sanitizeBody`'s key list and the adapter registry had drifted. A declared secret was persisted in plaintext. **FIXED.**
`backend/src/middleware/audit-log.ts` · `backend/src/services/adapter-registry.ts`

`sanitizeBody` asked "is this key sensitive?" by substring-matching `['key','token','secret','password','apiKey','api_key','refreshToken','accessToken']`. The **registry** is what decides which adapter fields are secrets, and it declares four:

```
openclaw_gateway.x-openclaw-token   matches 'token'   → redacted
openai_generic.apiKey               matches 'key'     → redacted
hermes_gateway.apiKey               matches 'key'     → redacted
http_webhook.webhookAuthHeader      matches NOTHING   → PLAINTEXT
```

`webhookAuthHeader` is `secret: true` and its value is an `Authorization` header — a bearer credential. Probed against the merged code:

```
sanitizeBody({ adapterId: 'http_webhook',
               agentDefaultsPayload: { webhookAuthHeader: 'Bearer SUPER-SECRET-VALUE' } })
→ {"agentDefaultsPayload":{"webhookAuthHeader":"Bearer SUPER-SECRET-VALUE"}}
```

This is H-3 exactly as originally written — *"the onboarding document instructs the joining agent to send its secret fields inside `agentDefaultsPayload`"* — surviving the fix for H-3, because the recursion reaches the key and then fails to recognize it. Dormant today (no ONB3 join route, no live hook); live the moment both exist.

**Fixed by making the registry the source of truth for both**: `allSecretFieldKeys()` (new, in `adapter-registry.ts`) enumerates every `secret: true` field key across all adapters, and `isSensitiveKey` matches the shape list **or** the registry set. A new adapter's secret is redacted the moment it is *declared*, with no second list to remember.

**Guarded** (`tests/audit-onb2-reaudit.test.ts`): a loop over every adapter × every declared secret field asserts a canary in `agentDefaultsPayload.<key>` never reaches the row. A future adapter that adds a creatively-named secret field fails this test rather than production.

### R-1 (MEDIUM) — `/api/traces` had no tenant scoping: authenticated, but not isolated. **FIXED.**
`backend/src/services/telemetry.ts`

`spans` is **one process-wide, in-memory buffer** shared by every tenant on the machine. #248 put `GET /api/traces` behind Clerk, which narrowed it from *anyone on the internet* to *any authenticated Clerk user* — including a member of any other org, and any self-signup. The span carries `http.url`, `org.id`, `user.id`, provider, model and timing. So org A could read org B's span metadata. **Real cross-tenant metadata leak; correctly flagged by the fixer as residual.**

Severity is MEDIUM rather than HIGH only because of *what is currently in the buffer*: the `onRequest`/`onResponse` hooks that write `org.id`/`user.id`/path are the dead ones (H-1), so today's buffer holds only `llm.call` spans from `llm-router.ts` — provider, model, duration, **no org attribution**. That is still cross-tenant metadata (which models other orgs run, and how often), but it is not identity data. **The day the operator enables the hook (GO-LIVE §7), this becomes a full cross-tenant path/org/user leak.** Same latency trap as everything else in this epic.

**The obvious fix does not work, and this is the load-bearing detail.** "Just add `requireOrgRole('owner')` to `/api/traces`" produces a **gate that is not a gate**:

```ts
// middleware/rbac.ts
const orgId = (req.params as any)?.orgId
if (!orgId) return          // No org context — skip RBAC   ← silently allows
```

With no `:orgId` in the path, `requireOrgRole` checks nothing and returns. The route would have *looked* owner-gated in the diff, in the route table, and to the next auditor.

**Fixed by giving the route an org to be scoped to:**

- `GET /api/traces` → **`GET /api/orgs/:orgId/traces`**, `preHandler: requireOrgRole('owner')` (now a real gate — there is an `:orgId` to read).
- New `getSpansForOrg(orgId, limit)` returns only spans whose `org.id` attribute equals the caller's org. **A span with no `org.id` is returned to nobody** — an unattributed span cannot be shown to one tenant without risking showing them another's.
- **It also closes the guard's structural blind spot.** The MCA-85 net only inspects routes matching `/:orgId|:agentId/`. A bare `/api/traces` serving cross-tenant data was **invisible to that guard by construction** — it could only ever be caught by the hand-written spot-check #248 added. Under `:orgId`, it is inside the net permanently. `auth-scoping.test.ts` additionally asserts the bare `/api/traces` is *gone*, not merely shadowed.

**Contract change (deliberate, and cheap):** `GET /api/traces` is **removed**, not aliased — an alias with no `:orgId` cannot be tenant-gated, which is the whole finding. Grepped `web/`, `cli/`, `app/` and `backend/`: **no caller exists** anywhere in the monorepo. Only `docs/API.md` (updated) and two tests (updated) referenced it. Nothing to migrate.

**Known consequence, and the follow-up:** `llm.call` spans carry no `org.id` (`LLMStreamOpts` has none to give), so they are unattributed and the org-scoped endpoint therefore **under-reports** today. That is the correct direction to fail — it shows a tenant too little rather than another tenant's data. Restoring the endpoint's usefulness means threading an org id into `LLMStreamOpts` and stamping `org.id` on the `llm.call` span. That touches a hot signature across every callsite (`backend/CLAUDE.md`: *"do NOT change existing function signatures without checking every callsite"*), so it is **out of scope for a security fix** and left as a follow-up. Isolation first; utility second.

### R-3 (LOW) — `?limit=` was unclamped. **FIXED (traces only).**
`Number(limit)` on a junk query (`?limit=abc`) yields `NaN`. In `getSpansForOrg` this is now clamped to `[1, MAX_SPANS]` with a 50 default. **Not fixed, pre-existing, deliberately left:** the same pattern in `auditLogQueryRoutes` reaches Drizzle's `.limit(NaN)`. It is a 500, not a leak, and it is on an owner-gated route that returns `{ logs: [] }` today — I am not touching the audit query path in a PR whose whole point is that its scope is now correct. Worth a one-line clamp whenever that route is next opened.

### R-4 (LOW / footgun, NOT fixed — deliberately) — `requireOrgRole` silently passes when there is no `:orgId`.
`backend/src/middleware/rbac.ts:15`

`if (!orgId) return` means `requireOrgRole('owner')` is a **no-op on any route without an `:orgId` param**. That is defensible as written (it is an *org*-role check, and the Clerk hook has already established a session), and changing it to fail-closed would be a breaking change across every route that composes it — a change I will not make unilaterally inside a security fix, because a fail-closed flip could 403 live routes.

But it is a live trap for exactly the next person who reaches for it: the natural fix for R-1 was to hang `requireOrgRole('owner')` on `/api/traces`, and it would have compiled, passed review, and enforced **nothing**. Recommendation for a separate PR: rename to `requireOrgRoleIfOrgScoped`, or make it `throw` when applied to a route whose path has no `:orgId` (a boot-time assertion, not a request-time one, so it cannot break production traffic). Flagged, not fixed.

---

## RULINGS ON THE FOUR RESIDUALS

### 1. `/api/traces` has no tenant scoping — **REAL. Confirmed. Fixed here.**
A genuine cross-tenant metadata leak, correctly characterized by the fixer as "a narrowing, not isolation". Ruled **MEDIUM** today (the buffer holds only unattributed `llm.call` spans, because the span-writing hook is the dead one) and **HIGH the moment H-1 is enabled**. It is fixed now rather than deferred, because the whole thesis of this epic is that these compose the day someone flips one switch.

**Shipped:** `GET /api/orgs/:orgId/traces`, owner-gated on a real `:orgId`, spans filtered to the caller's org, unattributed spans served to nobody, bare `/api/traces` removed. **This is both options in the brief at once** — owner-gating *and* org-filtering — because owner-gating alone was not actually available: `requireOrgRole` no-ops without an `:orgId` (R-4), so containment required the re-path regardless. No product decision was needed and none was taken; there are no callers and no contract to break.

### 2. The depth cap returns `'[TRUNCATED]'` — **SAFE CONTAINMENT, not a redaction hole. Confirmed.**
At `depth >= 8` the **entire subtree is replaced** by the marker string; the walk stops and nothing below it is copied into the row. It drops data, it does not pass data through, so nothing below the cap can survive under any key name. The ordering is also right: strings are scrubbed *before* the depth check, so a string at the boundary is still run through `redactTokensInText` rather than falling out un-redacted. The failure mode is loss of audit detail on a >8-deep body (bodies are Zod-validated payloads; none is close), which is the correct direction to fail. Also the only thing standing between a hostile or cyclic body and an unbounded walk. **Keep as is** — now locked by a test that asserts a past-the-cap secret *and* its innocuous sibling are both absent.

### 3. `redactTokensInText` only catches our own four token prefixes — **pre-existing contract, correctly characterized, but the ONB3 exposure was BIGGER than stated. Partly fixed.**
The free-text scrubber (`mci_inv_|mca_|art_|mcc_`) is a **belt for our own credentials**, not a general secret detector. A third-party secret in free text under a non-secret key (`{ note: "the key is sk-live-abc123" }`) still passes. That is the pre-existing contract and it is the right one — a general secret-detector is a heuristic that fails open and breeds false confidence. **Confirmed: keep, do not extend.**

The real defence for third-party secrets is the **key-based** test, not the text scrubber — and that is precisely where I found the hole (R-2): the key test did not cover a key the registry itself declares secret. That is fixed, so **ONB3's actual exposure is now covered**: every adapter secret field the onboarding doc tells an agent to send is redacted by name, at any depth, sourced from the registry.

**Residual, honestly stated:** a secret that arrives *in free text* under an *innocuous key* and is *not one of our four prefixes* still reaches `audit_logs.metadata`. Example: a joining agent that puts its provider key in a `notes` field. This is unavoidable without a fail-open heuristic; the containment is that the audit row is owner-gated and the trail is off. **ONB3 should not add a free-text field to the join body.** If it does, that field must be treated as secret-bearing by name.

### 4. The guard boots `auditLogPlugin` with a no-op sink — **route-tagging coverage only. Correct, and not a sink claim. Confirmed.**
`bootLikeIndex()` passes `{ sink: () => {} }` purely so the guard never reaches Turso while it enumerates routes. The guard asserts on `collectedRoutes()` — what is registered and how it is auth-tagged — and asserts nothing about persistence. That is exactly the right scope for a *leak guard*, and the no-op sink is a legitimate use of the injectable-sink seam (the audit's own recommended pattern). It makes **no claim** that the trail records anything, and the separate `[ONB2-H1]` tripwire asserts the opposite, loudly. **No finding.** Worth stating plainly, since a future reader could mistake "the guard boots the audit plugin" for "the audit plugin works": it does not, and nothing here says it does.

---

## WHAT I SHIPPED

| # | Change | File |
|---|---|---|
| R-2 | `allSecretFieldKeys()` — registry enumerates every declared secret field key | `services/adapter-registry.ts` |
| R-2 | `isSensitiveKey` matches the shape list **or** the registry set | `middleware/audit-log.ts` |
| R-1 | `GET /api/traces` → `GET /api/orgs/:orgId/traces`, owner-gated on a real `:orgId` | `services/telemetry.ts` |
| R-1 | `getSpansForOrg()` — spans filtered to the caller's org; unattributed spans to nobody | `services/telemetry.ts` |
| R-1 | Registration comment + the removed bare route | `src/index.ts`, `docs/API.md` |
| R-3 | `?limit=` clamped to `[1, MAX_SPANS]` on the traces route | `services/telemetry.ts` |
| guard | Every adapter × every declared secret field → canary never reaches the row; the `webhookAuthHeader` regression; the depth-cap containment proof | `tests/audit-onb2-reaudit.test.ts` (new) |
| guard | Org-isolation of spans; 401 without a session; the bare `/api/traces` is gone | `tests/traces-tenant-scoping.test.ts` (new) |
| guard | MCA-85 spot-check moved to the org-scoped path + asserts `/api/traces` is absent | `tests/auth-scoping.test.ts` |

**1167 backend tests (+7) · 11/11 evals · typecheck clean · `web` build clean.**

## LEFT OPEN — decisions, not defects

- **H-1 — enable the audit trail.** Untouched. Still a no-op, still tripwired, still an **operator cost call** (`GO-LIVE.md` §7). The trail is now safe-to-enable-by-construction *including* the two gaps #248 missed — which is the point: R-2 would have written a plaintext bearer token into the first row it ever recorded.
- **`allowShell` / `MC_ALLOW_SHELL`** (audit M-5). Untouched. Still a **product decision**.
- **R-4 — `requireOrgRole` no-ops without an `:orgId`.** Flagged, not fixed: fail-closed is a breaking change across every composing route. Own PR.
- **Follow-up (utility, not security): attribute `llm.call` spans with an org id** so `GET /api/orgs/:orgId/traces` stops under-reporting. Requires threading an org id through `LLMStreamOpts`.
- **Unchanged and still true from the ONB2 audit:** M-2 (token in a URL path — accepted risk), M-3 (per-IP rate limit is a precondition of turning `MC_ENABLE_REMOTE_ONBOARDING` on in production), M-4 (injectable finder on `agentInviteDocRoutes`, to be done in ONB3).

## ONB3: CLEAR TO START

No blocker and no unfixed defect stands between here and the join route. The two open items are decisions, and neither gates writing ONB3. Carry these three into it:

1. **Don't add a free-text field to the join body** (ruling 3's residual). If you must, treat it as secret-bearing by name.
2. **Do M-4's injectable finder** — ONB3's route *writes*, and it should be end-to-end testable on the day it is written.
3. **The per-IP rate limit gates the flag, not ONB4** (M-3) — it must exist before `MC_ENABLE_REMOTE_ONBOARDING` is ever set in production.
