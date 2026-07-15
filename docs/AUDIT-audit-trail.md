# AUDIT — Audit-trail enablement (Epic ONB, audit finding H-1 · PR #257)

**Auditor:** independent code/security review (did not build this).
**Target:** `f3fc40e` on `main` — the hoist that turned the previously-dead audit hook into a
live writer of the hosted Turso `audit_logs` table for sensitive/write requests.
**Reviewed:** `docs/AUDIT-ONB2.md` (H-1/H-2/H-3), `docs/AUDIT-ONB2-hardening.md` (R-1/R-2),
the PR #257 diff, `middleware/audit-log.ts` (hoisted `auditLogPlugin` + `shouldAudit` +
`buildAuditRow` + recursive `sanitizeBody` + `redactPath`), `services/audit-retention.ts`,
`services/scheduler.ts`, `db/setup.ts`, `services/log-redaction.ts`,
`services/adapter-registry.ts` (`allSecretFieldKeys`), the `[ONB2-H1]` tripwire, the
audit-log/traces query routes, and `GO-LIVE.md` §7.

---

## VERDICT: **PASS-WITH-FIXES**

The enablement is safe by construction on the crux that matters — **no secret or token can
reach a persisted row** — and I proved that end-to-end through the live hook myself, not just
by reading the tests. The insert cannot harm the recorded request, scope skips the GET flood,
reads stay owner-gated, and the tripwire guards the safety envelope behaviourally.

One **HIGH** defect in the retention guard let a plausible env typo wipe the entire audit
table — the exact invariant the code documents but did not enforce. **I fixed it** (one-line,
intent-preserving, regression-tested). The remaining items are operator/product calls, left in
this report. With the fix, the trail is **safe as enabled in production.**

| Severity | Count | Disposition |
|---|---|---|
| Blocker | 0 | — |
| High | 1 | **FIXED in this PR** (retention table-wipe) |
| Medium | 1 | Left — cost/scope, operator call |
| Low / observational | 1 | Left — completeness, product call |
| Nit | 1 | Left — metadata cardinality, shape change |

---

## HIGH — FIXED

### H-A — A sub-one-day `MC_AUDIT_RETENTION_DAYS` typo wipes the entire audit table. CONFIRMED.

`services/audit-retention.ts:auditRetentionDays()` (pre-fix):

```ts
const n = env.MC_AUDIT_RETENTION_DAYS ? Number(env.MC_AUDIT_RETENTION_DAYS) : NaN
return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AUDIT_RETENTION_DAYS
```

The function's own doc-comment promises "an operator cannot accidentally set retention to 0
(which would delete everything on the next tick) with a typo," and the test suite checks the
integer `'0'`, `'-5'`, `'abc'` → all default to 90. But a **fractional value in (0, 1)** —
`0.5`, `.5`, `0.9`, `1e-9`, `0.0001` — passes the `n > 0` gate and is then collapsed by
`Math.floor` to **0**. Retention 0 → `auditRetentionCutoff(now, 0) === now` →
`maybeRunAuditRetention` runs `DELETE ... WHERE created_at < now` on the next daily tick →
**every audit row is deleted.**

Proven empirically before fixing:

```
env="0.5"    -> days=0  cutoff=2026-07-15T12:00:00.000Z   <-- WIPES ALL ROWS (cutoff >= now)
env=".5"     -> days=0  cutoff=2026-07-15T12:00:00.000Z   <-- WIPES ALL ROWS
env="1e-9"   -> days=0  cutoff=2026-07-15T12:00:00.000Z   <-- WIPES ALL ROWS
env="0.0001" -> days=0  cutoff=2026-07-15T12:00:00.000Z   <-- WIPES ALL ROWS
env="1"      -> days=1  cutoff=2026-07-14T12:00:00.000Z   (safe)
```

Not remotely exploitable — it needs an operator to set the Fly secret to a fraction — but the
whole thesis of this PR ("retention can't wipe the table," GO-LIVE §7) is exactly what it
breaks, and the trail is a compliance/security artefact whose value is that it is not silently
destroyed. **HIGH by impact.**

**Fix (applied):** the accept gate is now `n >= 1`, not `n > 0`, so `Math.floor(n) >= 1` always
holds for an accepted value and the cutoff is always ≥ 1 day in the past. All prior passing
tests still pass (`'30'→30`, `'365'→365`, `'0'→90`, `'-5'→90`, `'abc'→90`, `'45.9'→45`); the
sub-one-day hole is closed.

- `services/audit-retention.ts` — `n > 0` → `n >= 1`, comment updated.
- `tests/audit-onb-enable.test.ts` — regression: every sub-one-day fraction → 90; plus an
  invariant test that **no** accepted env yields a cutoff `>= now`.
- `GO-LIVE.md` §7 — documents the whole-day (≥ 1) minimum and why.

---

## MEDIUM — left (operator/cost call)

### M-A — "sensitive writes" is really *all writes API-wide*, including recurring agent chatter.

`shouldAudit(method, path)` returns `true` for **every** `POST/PUT/PATCH/DELETE` on **any**
path (health probes excepted), not just the onboarding/invite/join/approval surfaces. That
sweeps in the high-frequency agent-API writes: `POST /api/agent/heartbeat` (posted once per
adapter poll loop, per active agent), `POST /api/agent/runs/:id/log`,
`POST /api/agent/tasks/:taskId/result`, `POST /api/agent/plugin-jobs/:id/{claim,result}`,
`POST /api/agent/messages`, etc. Each is one fire-and-forget Turso INSERT.

The GET dashboard flood is correctly skipped, but the *write* volume is set by
`active agents × heartbeat cadence`, and heartbeat/run-log chatter can easily dominate the
onboarding events the trail was framed around. 90-day retention bounds the table's total size,
but the daily insert *rate* (and thus Turso write cost) is unbounded by anything in this PR.

This matches the documented intent ("every mutating method") and is tunable — `shouldAudit` is
a pure, tested helper and GO-LIVE §7 says how to narrow it. It is an **operator cost decision**,
not a defect, so I left it. Recommendation: consider excluding the heartbeat / run-log agent
endpoints from `shouldAudit` (they are liveness/telemetry noise, not security events), or
gate the "all mutating methods anywhere" arm to the org-scoped surfaces you actually audit.

---

## LOW / observational — left (product/completeness call)

### L-A — onboarding/join/claim events record `orgId=null` / `userId=null`, so an owner can't read them.

The audit row's `orgId` comes from `(req.params as any)?.orgId` and `userId` from
`req.auth?.userId`. The token-addressed public onboarding routes
(`POST /api/agent-invites/:token/join`, the claim, `GET …/onboarding.txt`) carry **no**
`:orgId` param and run **before** Clerk, so both fields are `null` (confirmed in my probe).

This is **not a leak** — arguably it's more private — and `orgId=null` provenance is *correct*,
not a bug (task item 7). But `GET /api/orgs/:orgId/audit-log` filters `eq(orgId, orgId)`, so
these null-org rows are **invisible to every org owner**. The trail keeps the very "who looked
at the onboarding doc / who asked to join" events that `AUDITED_PATH_SEGMENTS` was added to
capture, yet no owner-facing query can retrieve them. Closing it means resolving the org from
the invite/join token inside the hook — a design change beyond this audit. Left for product.

---

## NIT — left (record-shape change)

### N-A — `sanitizeBody` caps string length and depth, but not array length or object cardinality.

`sanitizeValue` truncates each string > 200 chars and stops at `MAX_DEPTH = 8`, but a wide
body (a large array, or an object with thousands of keys) is copied in full. The only real
bound on `audit_logs.metadata` size is Fastify's default 1 MB `bodyLimit` (no custom limit is
set), so worst-case metadata is ~1 MB per sensitive row. Bounded and not a DoS, but a wide body
still costs more storage than it should. A total-size / element-count cap would tighten it —
left unfixed because it changes the shape of a persisted record, which (consistent with the
prior ONB2 auditors' restraint) belongs with an operator sign-off, not an auditor's fix.

---

## VERIFIED CLEAN

**1. No secret/token reaches a persisted row — the crux. PROVEN END-TO-END.**
I booted the hook exactly as `src/index.ts` wires it (hoisted on the root, real routes as
descendants) and drove a real credential write plus an ONB3-shaped join carrying a nested
registry secret (`webhookAuthHeader`), an obvious `apiKey`, a token in the path, a token in the
query string, tokens echoed in free text (`mca_…`, `mcc_…`), and a token in the *response* body.
I then inspected **every field** the row stores. Result:

```
credential.add : path=/api/orgs/org_ABC/credentials  metadata={provider, apiKey:[REDACTED]}
                 orgId=org_ABC  userId=user_CLERK123
post.agent-invites : path=/api/agent-invites/:token/join  orgId=null  userId=null
                 metadata.agentDefaultsPayload={externalEndpoint, apiKey:[REDACTED], webhookAuthHeader:[REDACTED]}
                 metadata.note="… mci_inv_[REDACTED] … mca_[REDACTED] … mcc_[REDACTED]"
LEAK SCAN: all 9 live secrets/tokens -> clean ✅   RESULT: PASS
```

- **Path** — `redactPath` replaces `mci_inv_`/`mca_`/`art_`/`mcc_` segments with `:token` and
  drops the whole query string; the derived `action` is computed from the *redacted* path.
- **Metadata** — `sanitizeBody` recurses over objects/arrays to `MAX_DEPTH`, redacts keys by
  the shape list *and* the registry secret detector (`allSecretFieldKeys()`, so
  `webhookAuthHeader` — which matches no shape word — is caught), and runs every surviving
  string through `redactTokensInText`. Metadata is only built for `SENSITIVE_METHODS`.
- **Response bodies are never captured** — the hook reads `req.body` only, so the `mca_` agent
  token / `mcc_` claim secret that live in *response* bodies never enter a row (and would be
  scrubbed by prefix even if they did).
- **actor/org** — `userId`/`orgId` are identifiers, not secrets.

**2. The insert cannot harm the request.** `sink(buildAuditRow(...))` is called, not awaited;
`dbSink` fires `db.insert(...).values(row).catch(...)`, so the DELETE/INSERT adds no latency and
a DB failure is swallowed (logged), never surfaced to the recorded request. No unhandled
rejection path. Body size is bounded by Fastify's 1 MB default (see N-A).

**3. `shouldAudit` does what it claims.** Mutating methods + `/agent-invites`,
`/agent-join-requests`, `/approvals` are audited; the `GET` org/agent/task dashboard poll and
`/health`, `/ready`, `/api/health` are skipped. Not "every GET." (Volume caveat: M-A.)

**4. Retention is safe (post-fix).** Default 90; unset/junk/0/negative/sub-one-day → 90 (H-A);
`45.9 → 45` floored; daily gate fires once per UTC day at/after 03:00; the prune is a bounded
`DELETE … WHERE created_at < cutoff`; `idx_audit_logs_created` serves both the prune and the
query `ORDER BY`. The prune runs per-instance but is idempotent, so horizontal scaling is safe.

**5. Reads stayed gated.** `auditLogQueryRoutes` and `telemetryQueryRoutes` are registered in
the Clerk-authenticated `secured` scope with `requireOrgRole('owner')`, on `:orgId` paths (so
the RBAC gate is *not* the no-op it would be on a bare path). Both refuse an unauthenticated
caller with 401 (tested). Enabling writes did not open reads.

**6. The tripwire guards the safety envelope — not green-by-construction.** `[ONB2-H1]` asserts
the hook is hoisted (`auditLogPlugin(app)`) and NOT re-encapsulated
(`app.register(auditLogPlugin)`), telemetry stays a plain `register()` (off), path redaction +
body sanitize hold on a canary row, and the GET flood is skipped. Each assertion fails in the
corresponding bad state. Telemetry remains OFF (encapsulated); this PR did not enable it.

**7. `orgId` provenance is correct.** Route-param sourced, `null` on non-`:orgId` paths (not a
wrong-org leak). Historical rows: none — `audit_logs` never recorded before this change (H-1
was a true no-op), so there is no back-catalogue of un-redacted rows.

---

## What I changed

- `backend/src/services/audit-retention.ts` — retention accept gate `n > 0` → `n >= 1` (H-A).
- `backend/src/tests/audit-onb-enable.test.ts` — regression tests for the sub-one-day wipe and
  a cutoff-never-≥-now invariant.
- `GO-LIVE.md` §7 — retention doc states the ≥ 1 whole-day minimum and why.

**Tests:** `npm test` → **1233 pass / 0 fail**. `npm run typecheck` clean. `main` green.
