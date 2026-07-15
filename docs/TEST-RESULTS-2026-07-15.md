# 7Ei Mission Control — Test Results (2026-07-15)

**Run type:** Autonomous test-execution pass (TEST + REPORT only; no product code changed).
**Branch:** `test/full-suite-battery-2026-07-15` · **Base:** `origin/main` @ `8ceee15` (clean tree, in sync).
**Host:** macOS (Darwin 25.5.0) · Node v22.23.1 · npm 10.9.8 · Python 3.14.5 · openpyxl 3.1.5 (venv).
**Deployed backend probed:** https://7ei-backend.fly.dev (version 1.3.0, `db: connected`).

---

## TL;DR

- **Automated suite: 100% green.** 1556 automated checks across 6 suites, **0 failures**.
  - backend `npm test` **1277/1277**, `npm run evals` **11/11**, `npm run typecheck` **clean**
  - web `npm test` **191/191**, `npm run typecheck` **clean**, `npm run build` **compiled successfully**
  - cli `npm test` **15/15** · adapter/claude-code (pytest/unittest) **48/48** · adapter/arturita-host **7/7** · adapter/arturita-stt **7/7**
- **77-case QA battery:** **72 Pass (auto)**, **1 Pass (probe)**, **4 Manual (needs operator)**, **0 Fail**.
- **Real bugs found: 0.** No P0/P1 security invariant failed. Every probe matched its expected result.
- **Coverage observations (not failures): 3** — minor test-coverage gaps to consider (MTI-03 ownerId-strip, CCS-04 migration idempotency re-run, AVL-10 Arturita-panel blank-key path). None affect shipped behavior.
- **4 cases still need the operator** (authed browser session, real mic/Ollama, or the built signed `.app`): CCA-01, MVG-04, PDE-01, PDE-05.

---

## Part 1 — Automated suite (exact results)

All commands run on `test/full-suite-battery-2026-07-15` (= `origin/main` @ `8ceee15`).

| Suite | Command | Result | Count | Exit |
|---|---|---|---|---|
| Backend unit/integration | `cd backend && npm test` | ✅ PASS | **1277 pass / 0 fail** (815 top-level subtests, 159 suites) | 0 |
| Backend orchestration evals | `cd backend && npm run evals` | ✅ PASS | **11/11 scenarios** | 0 |
| Backend typecheck | `cd backend && npm run typecheck` | ✅ PASS | `tsc --noEmit` **0 errors** | 0 |
| Web unit | `cd web && npm test` | ✅ PASS | **191 pass / 0 fail** | 0 |
| Web typecheck | `cd web && npm run typecheck` | ✅ PASS | `tsc --noEmit` **0 errors** | 0 |
| Web build | `cd web && npm run build` | ✅ PASS | Next.js 15 "Compiled successfully in 2.5s"; routes `/`, `/dashboard`, middleware | 0 |
| CLI | `cd cli && npm test` | ✅ PASS | **15 pass / 0 fail** | 0 |
| Adapter · claude-code (Python) | `python3 -m unittest discover -s adapters/claude-code/test` | ✅ PASS | **48 tests OK** (denylist, guard-hook, headless) | 0 |
| Adapter · arturita-host | `cd adapters/arturita-host && npm test` | ✅ PASS | **7 pass / 0 fail** | 0 |
| Adapter · arturita-stt | `cd adapters/arturita-stt && npm test` | ✅ PASS | **7 pass / 0 fail** | 0 |

**Grand total: 1545 test assertions + 11 eval scenarios = 1556 automated checks, 0 failures.**

**Failing tests by name:** _none._ No flaky-looking failures were observed, so no re-run classification was needed.

**Notes:**
- `npm audit` is a known **non-blocking** CI check (documented) and is not a test failure — not run here.
- `apps/desktop/build-stage/web/` carries a generated **staging copy** of `web/` used by the packaging pipeline. It is a build artifact (identical test files) and was **not** run as a separate suite to avoid double-counting.
- The backend suite runs `node --test --import=tsx`; web/cli/adapters run the Node built-in test runner. No external test framework is involved.

---

## Part 2 — 77-case QA battery

Source workbook: operator's `7Ei_Mission_Control_Test_Battery.xlsx` (77 rows, read via openpyxl). Rows mirrored verbatim below with a determined **Result** + **Evidence**.

**Result legend:**
- **Pass (auto)** — a repo automated test covers the invariant and passes (cited by `file:line` + test name).
- **Pass (probe)** — verified by a SAFE, READ-ONLY probe (live backend or repo scan); probe output cited.
- **Manual** — not automatable here (needs authed browser, real mic/voice/Ollama, or the built signed `.app`). Not fabricated as a pass.
- **Fail** — a covering test failed or a probe contradicted the expected result.

Test-file shorthand: paths are under `backend/src/tests/` unless prefixed `web:` (under `web/`) or `adapter:` (under `adapters/`).

### Result counts by module

| Module | Cases | Pass-auto | Pass-probe | Manual | Fail |
|---|---:|---:|---:|---:|---:|
| Arturita (Voice & LLM) | 13 | 13 | 0 | 0 | 0 |
| Agents Experience | 13 | 13 | 0 | 0 | 0 |
| Onboarding (Invite→Claim) | 14 | 14 | 0 | 0 | 0 |
| Claude Code Agent | 5 | 4 | 0 | 1 | 0 |
| Memory / Vault Graph | 4 | 3 | 0 | 1 | 0 |
| Approvals & Low-Trust | 3 | 3 | 0 | 0 | 0 |
| Wallet | 4 | 4 | 0 | 0 | 0 |
| Machine Control (Host Daemon) | 3 | 3 | 0 | 0 | 0 |
| Multi-Tenant Isolation | 5 | 5 | 0 | 0 | 0 |
| Audit Trail | 4 | 4 | 0 | 0 | 0 |
| Packaging (Desktop/Electron) | 5 | 3 | 0 | 2 | 0 |
| Cross-Cutting Security | 4 | 3 | 1 | 0 | 0 |
| **Total** | **77** | **72** | **1** | **4** | **0** |

Several Pass-auto cases were **additionally corroborated by a live read-only probe** (noted inline): OIC-03, MTI-01, MTI-04, AT-03, CCS-01.

### Full case table

| ID | Module | Test Case | Pri | Result | Evidence |
|---|---|---|---|---|---|
| AVL-01 | Arturita | Local-first chain resolves | P0 | Pass (auto) | `arturita-pipeline.test.ts:23,41` — "LLM default is strictly local-first: Ollama primary + no cloud before local"; "usable default chain: local Ollama hops first, cloud guarantee strictly last" |
| AVL-02 | Arturita | Successful local answer short-circuits | P0 | Pass (auto) | `llm-fallback-runtime.test.ts:38` — "local primary success short-circuits — a later cloud hop (bad key) is never called" |
| AVL-03 | Arturita | Circuit breaker trips + cools + reprobes | P1 | Pass (auto) | `llm-fallback.test.ts:57` "breaker trips after threshold failures in the window, then cools down"; `llm-fallback-runtime.test.ts:88` "a 500 trips the breaker for the failed provider" |
| AVL-04 | Arturita | Invalid cloud key → actionable degrade | P0 | Pass (auto) | `arturita-pipeline.test.ts:196` "usableCloudProviders is empty when no cloud key is present (the live failure)"; `web:talkDiagnostics.test.ts:220` self-test warns with actionable command. _Note: exact user-facing degrade string in `converse` is a UI/manual confirmation._ |
| AVL-05 | Arturita | Whisper preferred over Web Speech | P0 | Pass (auto) | `web:sttEngine.test.ts:7,14` — "resolveSttEngine picks whisper when the bridge is reachable"; "shipped whisper-first default → whisper on the operator Mac" |
| AVL-06 | Arturita | Brave network error → graceful typed fallback | P0 | Pass (auto) | `web:talkDiagnostics.test.ts:68,77` "classifySttError treats a network error as unavailable + hinted (the Brave root cause)"; "names Brave specifically"; `:220` warns with Whisper start command |
| AVL-07 | Arturita | Fuzzy wake tolerates mishears | P1 | Pass (auto) | `voice.test.ts:56,63,99` — tolerates Whisper mishears; "art of eta" split; "every allowlisted variant matches" |
| AVL-08 | Arturita | Non-leading name does not trigger | P1 | Pass (auto) | `voice.test.ts:68` "still rejects unrelated leading speech"; `web:dashboard/cockpit/voicePanel.logic.test.ts:40` |
| AVL-09 | Arturita | OpenAI-compatible custom model insertion (key encrypted) | P1 | Pass (auto) | `custom-model.test.ts:62` "stores base URL, encrypts the key, upserts the chain"; `custom-model-agent.test.ts:86` "key stored encrypted, not plaintext" |
| AVL-10 | Arturita | Blank key on re-save preserves stored key | P1 | Pass (auto) | `custom-model-agent.test.ts:140` "re-saving without a key keeps the stored one"; `:152` "explicit empty key clears". _Coverage note below (#3): the Arturita-pipeline panel only unit-tests the explicit-empty-clears case (`custom-model.test.ts:87`)._ |
| AVL-11 | Arturita | Per-wake cost cap blocks costly wake | P0 | Pass (auto) | `preflight.test.ts:43` "blocks a wake whose worst-case cost exceeds the cap"; `:38` allows when no cap |
| AVL-12 | Arturita | Direct answer by default (brainstorm-first) | P0 | Pass (auto) | `arturita-converse.test.ts:7` "plain questions are answered directly (the default)"; `:113` prompt is identity + answer-directly + no-action |
| AVL-13 | Arturita | Explicit delegate routes to office; danger hits A2 | P1 | Pass (auto) | `arturita-converse.test.ts:49,87` explicit delegation routes to agent flow; `:25` destructive routes regardless of phrasing; `intent.test.ts:40` critical/destructive gating |
| AE-01 | Agents Exp. | Card renders avatar/name/handle/status/chips | P1 | Pass (auto) | `staff-grid.test.ts:88,96` "buildStaffCards … one card per agent"; `:121` carries uploaded avatar + emoji fallback |
| AE-02 | Agents Exp. | Status dot colorblind-safe | P1 | Pass (auto) | `staff-grid.test.ts:27` "colour is never the only signal, so every state carries a label" |
| AE-03 | Agents Exp. | Attention outranks running | P1 | Pass (auto) | `staff-grid.test.ts:45` "lets attention beat running — a busy agent with a blocked task still needs a human" |
| AE-04 | Agents Exp. | Click agent lands on Configuration | P1 | Pass (auto) | `web:agentRoute.test.ts:47` "opening an agent defaults to the Configuration tab"; `:16` parseAgentRoute reads `#agents/<id>/<tab>` |
| AE-05 | Agents Exp. | List + add + save markdown instruction files | P0 | Pass (auto) | `agent-detail-routes.test.ts:78` "saving an instruction file persists it and reads back"; `:92` update-not-duplicate; `:99` bad filename is a specific 400 (no traversal); `:108` non-owner cannot save |
| AE-06 | Agents Exp. | Avatar upload downscales to WebP | P1 | Pass (auto) | `web:avatarImage.test.ts:5,16` scaleDims fits/rounds; `:33` "encodeType prefers WebP and falls back to JPEG"; `agent-config.test.ts:96` builds data URI |
| AE-07 | Agents Exp. | SVG upload rejected | P1 | Pass (auto) | `web:avatarImage.test.ts:38` "isAcceptedUpload matches the backend allowlist and refuses SVG"; `agent-config.test.ts:109` rejects non-image type |
| AE-08 | Agents Exp. | Remove clears + falls back to icon; no 400 | P0 | Pass (auto) | `agent-detail-routes.test.ts:120` "removing the avatar clears avatar_url"; `:128` idempotent; `:139,149` bodiless DELETE/PUT reaches handler (`body-parser.test.ts:25,36`) |
| AE-09 | Agents Exp. | Tick/untick installs/uninstalls skills | P1 | Pass (auto) | `agent-detail-routes.test.ts:178,188` ticking installs / unticking uninstalls; `web:agentSkills.test.ts:20,25` |
| AE-10 | Agents Exp. | Orphaned skill doesn't 400 the toggle | P1 | Pass (auto) | `agent-detail-routes.test.ts:199` "an orphaned skill does not block toggling the others"; `agent-skills.test.ts:81` |
| AE-11 | Agents Exp. | Reports-to sets org chart, refuses loop | P1 | Pass (auto) | `agent-config.test.ts:72` "refuses a reporting loop"; `:15` wouldCycle; `orgchart.test.ts:30` "breaks cycles without losing agents" |
| AE-12 | Agents Exp. | Custom adapter selectable + used | P1 | Pass (auto) | `custom-model-agent.test.ts:104` "selectable as an agent's model"; `:96` "RUN path resolves the encrypted key + base URL" |
| AE-13 | Agents Exp. | Dashboard tab: latest run + charts + cost strip | P2 | Pass (auto) | `agent-overview.test.ts:151` "buildAgentOverview assembles the whole Dashboard payload"; `:114` "truthful for pre-split tasks, flags hasSplit=false" (— not fake 0) |
| OIC-01 | Onboarding | Single-use default + TTL + allowed adapters | P0 | Pass (auto) | `agent-invites.test.ts:49` single-use default; `:54` 72h TTL/cap; `:74` allow-list honoured; `:60` refuses out-of-range |
| OIC-02 | Onboarding | Token hash-only, shown once | P0 | Pass (auto) | `agent-invites.test.ts:39` "stores ONLY the hash — the record never carries the raw token"; `:195` view never carries token/hash |
| OIC-03 | Onboarding | Unknown/expired/revoked/exhausted → flat 404 | P0 | Pass (auto) + probe | `agent-invites.test.ts:158` "INDISTINGUISHABLE from the outside (flat not_found)"; `onb3-join-flow.test.ts:355` all states same flat 404. **Live probe:** GET onboarding.txt/claim with bogus `mci_inv_*` → **HTTP 404** identical envelope |
| OIC-04 | Onboarding | onboarding.txt renders from registry | P1 | Pass (auto) | `onboarding-doc.test.ts:103` "rendered FROM the registry — every allowed runtime, its fields and example"; `:154` connectivity/probe block; `:143` allow-list narrows the doc |
| OIC-05 | Onboarding | Strict body, secrets to encrypted store | P0 | Pass (auto) | `join-requests.test.ts:121,139` declared secrets split to encrypted bag; `:158` undeclared secret-shaped key refused; `adapter-registry.test.ts:121,127` allowlist not sanitize |
| OIC-06 | Onboarding | Single-use consume is atomic CAS | P0 | Pass (auto) | `onb3-join-flow.test.ts:178` "TOCTOU shape: two callers both read used_count=0 — exactly one consume wins"; `:218` two simultaneous joins, exactly one row |
| OIC-07 | Onboarding | Agent inactive until owner approves | P0 | Pass (auto) | `onb3-join-flow.test.ts:103` "a join creates a pending request + card — and NO agent row and NO token anywhere in the DB" |
| OIC-08 | Onboarding | Decide route enforces membership + owner-for-minting | P0 | Pass (auto) | `onb3-approval-gate.test.ts:122` non-member 403; `:151` member(non-owner) 403 minting; `:198` requiredRoleForApproval owner-for-minting, fail-closed unknown |
| OIC-09 | Onboarding | Approve → low_trust_review agent, no key | P0 | Pass (auto) | `join-requests.test.ts:231` "approval creates a CONTAINED agent for EVERY runtime"; `onb3-join-flow.test.ts:259` "CONTAINED agent with NO token; second approve is 409" |
| OIC-10 | Onboarding | Requires approved AND agent exists | P0 | Pass (auto) | `onb4-claim.test.ts:189` "a MISSING agent row is a flat 404 — never trust status=approved alone"; `:148` claim before approval is flat 404 |
| OIC-11 | Onboarding | Atomic single-use; token minted once | P0 | Pass (auto) | `onb4-claim.test.ts:208` "two simultaneous claims yield EXACTLY ONE token (claimed_at CAS)"; `:232` single-use even when both pass pre-checks; `:131` replay is flat 404 |
| OIC-12 | Onboarding | Token hash-only, raw only in response, never logged | P0 | Pass (auto) | `onb4-claim.test.ts:102` "raw mca_ token EXACTLY ONCE, stored hash-only"; `:265` claim secret + agent token redacted out of logs |
| OIC-13 | Onboarding | Invite/claim tokens redacted before persistence | P0 | Pass (auto) | `log-redaction.test.ts:63` "buildAuditRow never carries a raw token"; `:77` "end to end … logs :token, never the token" |
| OIC-14 | Onboarding | internal never invitable; claude_code no autonomy | P1 | Pass (auto) | `adapter-registry.test.ts:29` "`internal` is declared but NOT invitable"; `:54` "claude_code defaults to plan mode and cannot select autonomy" |
| CCA-01 | Claude Code | Claims task, runs headless, posts result | P1 | **Manual** | Needs a registered `claude_code` agent + running adapter + live `claude -p` CLI in a `cc/` worktree against the backend. Partial auto coverage: `adapter:claude-code/test/test_cc_headless.py` (StreamJson parse, extract_result success/error, resolve_workdir plans worktree). **End-to-end run needs operator.** |
| CCA-02 | Claude Code | Shell command → A2 approval + step-up | P0 | Pass (auto) | `claude-code-agent.test.ts:14` "machine-renders verbatim argv, ignoring agent-supplied summary"; `dangerous-approvals.test.ts:119` argv verbatim; `:139` dangerous approve needs fresh session (step-up); `adapter:test_cc_guard.py` |
| CCA-03 | Claude Code | Autonomous OFF by default, triple-gated | P0 | Pass (auto) | `adapter:test_cc_headless.py` PermissionModeGate — "autonomous allowed only with both guards and denylist"; "default is plan"; "unknown collapses to plan"; `adapter-registry.test.ts:54` cannot select autonomy |
| CCA-04 | Claude Code | Denylist deny > allow > gate, fail closed | P1 | Pass (auto) | `claude-code-agent.test.ts:136` catastrophic patterns denied; `:186` deny beats allow in a chain; `:191` allowed only if every segment allows; `:196` empty gated; `adapter:test_cc_denylist.py` |
| CCA-05 | Claude Code | claude_code lands low_trust + explicit caps | P1 | Pass (auto) | `claude-code-agent.test.ts:83` "claude_code → low_trust_review + explicit caps + explicit boundary"; `:130` empty perms fall back to secure default (not allow-all) |
| MVG-01 | Memory/Vault | Vault selection persists | P2 | Pass (auto) | `vault-config.test.ts:5` "parseVaultConfig merges with defaults and tolerates junk"; `:14` custom-root safe-path. _(Persistence logic covered; the graph-reload UI is a visual check.)_ |
| MVG-02 | Memory/Vault | Graphify-first, native fallback | P1 | Pass (auto) | `vault-graph.test.ts:118` "parseGraphifyGraph normalizes … scopes to the vault root"; `:83` buildNativeGraph note nodes + wikilink edges (native fallback); `:167` tolerates garbage payload |
| MVG-03 | Memory/Vault | Nodes/edges/clusters render colorblind-safe | P2 | Pass (auto) | `vault-graph.test.ts:83,96` note nodes + wikilink + tag edges; `:21` folderOf clusters; `:109` degree drives prominence. _(Okabe-Ito palette + legend is a visual/manual render check.)_ |
| MVG-04 | Memory/Vault | Ollama pass adds communities/concepts | P2 | **Manual** | Needs local Ollama to run the label/cluster pass. Partial auto: `vault-graph.test.ts:141` "parseGraphifyGraph surfaces semantic community id + name"; `:161` native graph leaves community undefined. **Live semantic pass needs operator's Ollama.** |
| ALT-01 | Approvals | Tri-state approve/reject/request-changes | P0 | Pass (auto) | `approvals.test.ts:22` "requires a note for revision_requested"; `:41` exactly the three decisions; `review.test.ts:192` tri-state → queue outcome |
| ALT-02 | Approvals | Gated action quarantined + step-up (additive to A2) | P0 | Pass (auto) | `review.test.ts:128` "in-boundary gated action → quarantine with machine-rendered summary"; `:139` "quarantined DANGEROUS still requires step-up (never a cheaper path to danger)" |
| ALT-03 | Approvals | Agent limited to its boundary set | P1 | Pass (auto) | `review.test.ts:100` "low-trust boundary escape → refuse (contained)"; `:118` "empty boundary → touching ANY resource is refused"; `:110` escape wins over gated |
| W-01 | Wallet | Prepare: simulate/decode, never sign | P0 | Pass (auto) | `wallet.test.ts:71` "buildUnsignedTx assembles a key-free unsigned tx"; `:38` decodeCalldata; `wallet-policy.test.ts:35` "refuse when there is no simulation (simulate-before-sign)" |
| W-02 | Wallet | ≥$100 approval; per-day cap; allowlist | P0 | Pass (auto) | `wallet-policy.test.ts:69` "value at/above $100 requires approval + step-up"; `:82` per-day cap forces approval; `:88` off-allowlist forces approval; `wallet.test.ts:103` checkCaps |
| W-03 | Wallet | Autonomous mainnet signing OFF (2 guards) | P0 | Pass (auto) | `wallet-policy.test.ts:103` "mainnet cannot be autonomous while mainnetEnabled is false"; `:109` only when BOTH flags on; `:131` assertSigningAllowed throws (fail-closed); `:24` resolvePolicy fails closed |
| W-04 | Wallet | No key material persisted/logged | P0 | Pass (auto) | `wallet.test.ts:157` looksLikeKeyMaterial detects private keys + seed phrases; `:164` "assertNoKeyMaterial throws when a field carries key material"; `wallet-policy.test.ts:136` no unattended signing |
| MCH-01 | Machine Ctrl | Denylist blocks sensitive paths | P0 | Pass (auto) | `host-planner.test.ts:40` "hitsDenylist hard-denies catastrophic targets"; `:131` catches OS system-integrity + burner keystore; `adapter:arturita-host/test/host.test.mjs:19,41` |
| MCH-02 | Machine Ctrl | Caps + destructive fail closed | P0 | Pass (auto) | `host-planner.test.ts:63` "small read auto-safe; destructive needs approval"; `:71` over threshold → approval; `:76` over hard ceiling → refuse; `host.test.mjs:61` destructive fails closed without approval |
| MCH-03 | Machine Ctrl | Undo journal + /panic kill switch | P1 | Pass (auto) | `host-planner.test.ts:108` "buildUndoEntry + isReversible respect the window"; `host.test.mjs:70,84` staged + reversible via undo; `arturita-session.test.ts:169` "panicPlan pauses, revokes live sessions, cancels in-flight runs"; `:182` no-op safe |
| MTI-01 | Multi-Tenant | Non-member/wrong-org → 403 | P0 | Pass (auto) + probe | `membership-scoping.test.ts:289` "every NON-EXEMPT secured route 403s an authenticated NON-MEMBER"; `:304` unauthenticated → 401. **Live probe:** GET `/api/orgs/<foreign>/agents` with no session → **HTTP 401 `{"error":"Unauthorized"}`** |
| MTI-02 | Multi-Tenant | Foreign record → 403 fail closed | P0 | Pass (auto) | `membership-scoping.test.ts:362` "record-derived /api/agents/:agentId — non-member 403, member 200, missing row 403 (fail closed)"; `:420` every top-level record route of a foreign org 403s; `rbac-membership.test.ts:90` mapped-prefix missing record → 403 |
| MTI-03 | Multi-Tenant | Owner via ownerId keeps access; PATCH strips ownerId | P0 | Pass (auto) | `membership-scoping.test.ts:346` "GRANDFATHER: legacy org OWNER with no org_members row not locked out; outsider still 403s". ownerId-strip **code-verified** at `backend/src/routes/orgs.ts:149-153` (`const { ownerId:_o, id:_i, ...patch }`). _Coverage note #1: strip lacks a dedicated regression test._ |
| MTI-04 | Multi-Tenant | Agent-API + public onboarding unaffected | P0 | Pass (auto) + probe | `membership-scoping.test.ts:470` "agent-token API is NOT membership-gated: a valid-token request succeeds"; `auth-scoping.test.ts:199` only GET /api/adapters public. **Live probe:** GET `/api/adapters` → **HTTP 200** (public model intact) |
| MTI-05 | Multi-Tenant | Every secured route gated or exempt | P0 | Pass (auto) | `membership-scoping.test.ts:260` "leak-guard: EVERY secured route resolves an org OR is explicitly exempt"; `:280` "leak-guard is REAL: an ungated secured route makes this guard FAIL (self-test)" |
| AT-01 | Audit | Sensitive writes logged; flood excluded | P1 | Pass (auto) | `audit-onb-enable.test.ts:106` "the GET read-flood is NOT recorded, the onboarding GET is"; `:133` heartbeat/run-log/messages NOT audited; `audit-onb2-fix.test.ts:179` records sensitive writes, skips GET flood |
| AT-02 | Audit | Nested secret + token scrubbed from row | P0 | Pass (auto) | `audit-onb-enable.test.ts:65` "END-TO-END REDACTION: a nested secret + a path token never reach the persisted row"; `audit-onb2-reaudit.test.ts:26` EVERY declared secret field redacted; `audit-onb2-fix.test.ts:82` persisted row carries no secret |
| AT-03 | Audit | Query routes owner/membership-gated | P0 | Pass (auto) + probe | `audit-onb2-fix.test.ts:98` "GET /api/orgs/:orgId/audit-log not reachable without a session"; `traces-tenant-scoping.test.ts:78` traces need a session. **Live probe:** org-scoped route with no session → **HTTP 401** (same gate) |
| AT-04 | Audit | Sub-1-day retention can't wipe table | P0 | Pass (auto) | `audit-onb-enable.test.ts:222` "no accepted retention env can make the cutoff wipe every row"; `:203` defaults to 90, rejects junk/zero/negative; `:254` pruneAuditLogs deletes below cutoff |
| PDE-01 | Packaging | Packaged mesh boots on local file DB | P1 | **Manual** | Needs the built `.app`: backend on 127.0.0.1 with `file:` DB, migrations, `/api/health`, UI render. Route-collision guard is auto (`boot.test.ts:36`). **Live probe** confirms the hosted backend boots (`/api/health` → 200, `db: connected`) but that is the Turso/hosted profile, **not** the packaged file-DB path. Packaged boot needs operator. |
| PDE-02 | Packaging | Loopback auth: local operator = owner; no-session 401 | P0 | Pass (auto) | `loopback-auth.test.ts:41` "valid loopback secret authenticates AS the local operator"; `:52` missing/wrong bearer → 401; `:124` loopback bearer PASSES the secured membership gate, no bearer 401 |
| PDE-03 | Packaging | Per-install keys in Keychain; fail-closed default | P0 | Pass (auto) | `secret-keys.test.ts:28` "packaged with real per-install keys passes"; `:36` fails closed on missing SECRETS_ENC_KEY; `:43` on known dev defaults; `:54` on reused key; `:61` without loopback session secret |
| PDE-04 | Packaging | Hosted Clerk path unchanged; packaged unreachable on hosted | P0 | Pass (auto) | `secret-keys.test.ts:18` "hosted profile is a NO-OP — the guard never fires (byte-identical boot)"; `deployment-profile.test.ts:78` packaged loopback trusted, remote-onboarding not required. _(The Vercel env flag `NEXT_PUBLIC_MC_PACKAGED` unset is a deploy-config invariant.)_ |
| PDE-05 | Packaging | Unsigned build produced; signing wired-but-inert | P1 | **Manual** | Needs `cd apps/desktop && npm run dist:mac` to produce an unsigned `.app`/`.dmg` and confirm notarize self-skips + CSC override. **Build step needs operator.** (Covered by the H1 audit doc `docs/AUDIT-H1.md`, not by a unit test.) |
| CCS-01 | Cross-Cutting | PUT/DELETE preflight allowed (regression) | P0 | Pass (auto) + probe | `cors.test.ts:41` "preflight allows every verb the dashboard uses"; `:64` CORS_METHODS covers every agent-route verb. **Live probe:** OPTIONS preflight → `access-control-allow-methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS` |
| CCS-02 | Cross-Cutting | Per-org HMAC verified; forged → 403 | P0 | Pass (auto) | `webhook-auth.test.ts:55` "rejects a token minted for a different org or channel (no replay)"; `:81` telegram forged/absent rejected; `:119` jira forged rejected; `:47` configured secret enforces correct token |
| CCS-03 | Cross-Cutting | No secret/key material in git tree/history | P0 | **Pass (probe)** | Repo scan: tracked `.env` files are `*.env.example` + preset templates carrying only `<placeholders>` (`adapters/presets/*.env` → `<paste-agent-token>`, `<openai-api-key>`, …). Tree scan for `BEGIN * PRIVATE KEY` / `AKIA…` / live `sk-…`: only match is the fake test fixture `sk-1234567890abcdefghij` in `sprint4.test.ts:166`. History scan (`git log -S`, 60 revs) for private-key blocks / AWS keys: **no matches.** |
| CCS-04 | Cross-Cutting | Migrations idempotent, safe defaults, no backfill | P1 | Pass (auto) | Additive columns present + nullable defaults: `db-001.test.ts:6-26`, `sprint4.test.ts`, `sprint7.test.ts:10`, `cost-routes.test.ts:68`. Idempotent-ALTER convention is `backend/src/db/setup.ts` (per `backend/CLAUDE.md`); the full suite boots migrations on a fresh DB. _Coverage note #2: no dedicated "re-run on an existing DB is idempotent" assertion._ |

---

## Real bugs / failures

**None.** Every automated suite passed with zero failures, and every live read-only probe matched the battery's expected result. No P0 or P1 security invariant regressed.

## Coverage observations (not failures — for triage, no fix required to ship)

These are minor **test-coverage** gaps where the shipped behavior is correct/code-verified but lacks a dedicated assertion. Suggested as small follow-ups; none is a defect.

| # | Sev | Case | Observation | Suggested follow-up |
|---|---|---|---|---|
| 1 | P2 | MTI-03 | `ownerId`/`id` strip on `PATCH /api/orgs/:id` is code-verified (`orgs.ts:149-153`) but has no dedicated regression test asserting a caller cannot self-escalate ownership via PATCH. | Add a route test: PATCH with `ownerId` in body → stored owner unchanged. |
| 2 | P2 | CCS-04 | Migration column-presence is tested; the "re-run migrations on an existing DB is idempotent / no backfill / existing rows unchanged" property is exercised only implicitly by suite bootstrap. | Add a fresh-then-existing double-run test around `db/setup.ts`. |
| 3 | P2 | AVL-10 | The Arturita **pipeline** custom-model panel unit-tests only the explicit-empty-clears path (`custom-model.test.ts:87`); the "blank field preserves stored key" path is asserted for the **agent** model path (`custom-model-agent.test.ts:140`) but not separately for the Arturita panel. Convention is consistent (`undefined`=keep, `''`=clear). | Mirror the keep-on-absent assertion for the Arturita pipeline panel, or confirm the UI never sends `undefined`. |

## Cases still needing operator (manual) verification

| Case | Pri | Why it needs the operator |
|---|---|---|
| CCA-01 | P1 | Full claude_code loop: registered agent + running adapter + live `claude -p` in a `cc/` worktree posting logs/result/heartbeat. (Headless parsing logic is unit-tested.) |
| MVG-04 | P2 | Local Ollama semantic label/cluster pass over a real vault graph. (Graphify-JSON parse of communities is unit-tested.) |
| PDE-01 | P1 | Launch the built `.app`; confirm backend on 127.0.0.1 with `file:` DB, migrations, `/api/health`, UI render. (Hosted boot is live-green; the packaged file-DB path is what's unverified.) |
| PDE-05 | P1 | `npm run dist:mac`: confirm unsigned `.app`/`.dmg`, notarize self-skip, CSC override honoured. (Signing is wired-but-inert per `docs/AUDIT-H1.md`.) |

---

## Reproduction

```bash
# Part 1 — automated suite (all from repo root unless noted)
cd backend && npm test && npm run evals && npm run typecheck
cd ../web && npm test && npm run typecheck && npm run build
cd ../cli && npm test
cd .. && python3 -m unittest discover -s adapters/claude-code/test -v
(cd adapters/arturita-host && npm test)
(cd adapters/arturita-stt && npm test)

# Part 2 — live read-only probes (no mutation)
curl -s https://7ei-backend.fly.dev/api/health
curl -si -X OPTIONS https://7ei-backend.fly.dev/api/agents/x/config \
  -H 'Origin: https://app.7ei.ai' -H 'Access-Control-Request-Method: PUT'
curl -s -o /dev/null -w '%{http_code}\n' https://7ei-backend.fly.dev/api/orgs/x/agents   # 401
curl -s -o /dev/null -w '%{http_code}\n' https://7ei-backend.fly.dev/api/adapters          # 200

# Repo secret scan (CCS-03)
git grep -nIE "BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY|AKIA[0-9A-Z]{16}" -- . ':!*.example' ':!*.md'
```

_Generated by an autonomous test-execution pass on 2026-07-15. No product code was modified._
