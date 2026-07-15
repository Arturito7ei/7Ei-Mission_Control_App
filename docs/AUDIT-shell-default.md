# AUDIT — shell-execution default (Epic ONB, audit M5 / PR #260)

> Independent code/security audit of the shell-default change: **new agents default
> `MC_ALLOW_SHELL=0`, existing agents grandfathered, an opt-in checkbox added.** The auditor did
> not build it. Scope: `web/lib/adapterProfile.ts` (+ `.test.ts`), `web/app/dashboard/cockpit/{AddAgentWizard,HireDialog}.tsx`,
> the server adapter registry + its test (`backend/src/services/adapter-registry.ts`, `backend/src/tests/adapter-registry.test.ts`),
> the OpenClaw adapter's shell enforcement (`adapters/openclaw/mc_adapter.py`), and every other surface
> that emits or defaults `MC_ALLOW_SHELL` (`.sh`/`.env`/`.py`/`.ts`/`.md`, not just TS).
>
> Audited at `a731208` (PR #260, squash-merged to `main`). Fixes/flags from this audit ship in the audit PR.

## VERDICT: **PASS**

The change is correct, conservative, and does exactly what it claims. The crux — that flipping the
wizard's shell default **cannot** touch a running agent — is **empirically confirmed**: shell enforcement
is client-side only, so there is no server gate to break and the live OpenClaw ops agent is grandfathered
by construction. New agents ship shell-off, the opt-in flips it, Cursor/Claude-Code never emit the flag,
and registry ↔ wizard now agree, test-locked on both sides.

**No blockers, no fix-required findings in the changed code.** Two residual arms of the same drift exist
outside this change's declared scope (`adapters/mac-mini/setup.sh` and the `shell.env` preset doc); both
are **intentional / deliberately deferred product calls**, not defects — ruled below. Nothing was changed
in adapters, telemetry, or the `allowShell` defaults.

---

## 1. The crux — enforcement is CLIENT-SIDE ONLY (confirmed)

**Claim under test:** `allowShell` / `MC_ALLOW_SHELL` is enforced only by the on-host adapter reading its
own local env; no server/registry code gates shell or `machine_exec` from an agent's *stored* `allowShell`.
**If a server-side gate keyed on stored `allowShell` existed, flipping the wizard could retroactively break
the live agent — that would be a HIGH.** It does not exist.

**Evidence — the adapter (the only enforcer):**
- `adapters/openclaw/mc_adapter.py:31` — `ALLOW_SHELL = os.environ.get("MC_ALLOW_SHELL", "") in ("1","true","yes")`.
  Read **once, from the local process env**, at import. Default (absent/empty) → **off**.
- Gated at `:105` (`shell_execute` → *"shell execution disabled (set MC_ALLOW_SHELL=1)"*) and `:175`
  (the `llm_execute` tool loop refuses to run the model's bash block). Both read the module-local `ALLOW_SHELL`.
- `whoami()` (`:71`) fetches the agent's server-side identity, but the shell flag is **never** re-derived
  from that response — it comes only from the host's `mc.env`. So the server cannot turn a running agent's
  shell on or off; only the file on its host can.

**Evidence — the server (no gate):** a full-tree search for `allowShell` across `backend/` returns **only**
two lines, both in `adapter-registry.ts` — the field *declaration* (`:104`) and the *example* (`:107`).
Nothing reads it back. `allowShell` is a declared `agentDefaultsPayload` field: it is validated and may be
stored in an agent's config, but **it is never consulted to block anything**.

**Not to be confused with `machine_exec`.** The backend *does* have a server-side host-command gate — the
`machine_exec` / `executesHostCommands` path (`dangerous-approvals.ts`, `cc-denylist.ts`, step-up approvals,
`code-executor.ts`). That is a **separate mechanism** for the Claude-Code/CC epic, keyed on the `machine_exec`
approval + per-agent denylist + the `executesHostCommands` **capability** — **not** on the OpenClaw
`allowShell` field. The two do not intersect: the OpenClaw shell flag has no server enforcement, and the
`machine_exec` gate is untouched by this change. Confirmed by grep — the `machine_exec` gates never read
`allowShell`.

> **Ruling: CONFIRMED — enforcement is client-side only. There is no server-side shell gate keyed on
> stored `allowShell`. The live agent is safe.** This is the load-bearing fact behind the whole change.

---

## 2. Grandfathering — the live OpenClaw ops agent keeps shell (confirmed)

The live agent runs from `~/.openclaw/mc-adapter/mc.env` on its own host, which already contains
`MC_ALLOW_SHELL=1`. The change touches:
- `web/lib/adapterProfile.ts` — a **rendering** helper that produces a copy-paste block in the browser;
- two React dialogs that display that block.

None of these writes, reads, or rewrites any host's `mc.env`; the wizard produces text for a *new*
onboarding, never mutates an existing install. Combined with §1 (no server gate to flip), **nothing in the
change reaches an existing agent's runtime config.** The grandfathering is automatic and zero-touch — it is
a property of the architecture, not of a migration. Confirmed: the live adapter install and its `mc.env`
are untouched, and `adapters/mac-mini/setup.sh` (the live agent's own installer) is unchanged.

---

## 3. New-agent default + opt-in + registry↔wizard agreement (confirmed)

- **Default off.** `mcEnv()` appends `MC_ALLOW_SHELL=${opts.allowShell ? '1' : '0'}` **only** for
  `honorsShellFlag` runtimes (`openclaw`, `custom`). With no opt-in, a fresh openclaw/custom agent gets an
  explicit `MC_ALLOW_SHELL=0`. Test-locked (`adapterProfile.test.ts` — *"a new openclaw agent defaults to
  shell OFF"*, *"custom … also defaults OFF"*).
- **Opt-in flips it.** `runBlock(rt, API, token, { allowShell: true })` → `=1`, threaded through the full
  copy-paste block. Surfaced as an **advanced, off-by-default checkbox** (`useState(false)`) in both
  `AddAgentWizard` and `HireDialog`, shown only when `honorsShellFlag(rt)`. Test-locked.
- **Cursor / Claude-Code never emit the flag.** `honorsShellFlag` is false for them (Cursor = file inbox,
  Claude-Code = plan-mode permission model), so `MC_ALLOW_SHELL` never appears in their `mc.env`, opt-in or
  not. Test-locked (*"non-shell runtimes never emit MC_ALLOW_SHELL, even when opted in"*).
- **Registry ↔ wizard agree, both sides locked.** Registry: `adapter-registry.test.ts:65` asserts
  `openclaw_local.allowShell.default === false`. Wizard: `adapterProfile.test.ts` asserts the rendered
  `mc.env` never carries `MC_ALLOW_SHELL=1` by default. Both sides say **off**.

Web suite: **13/13 pass** (verified locally). Registry tripwire (autonomy enum) still green.

---

## 4. Ruling on the third arm — `adapters/mac-mini/setup.sh` (default `ALLOW_SHELL="1"`)

**Ruling: leaving it stable + flagged is the RIGHT call for this change. Recommend a future, non-blocking
refinement; do NOT flip it here.**

Why leave it:
1. It is the **live ops agent's own documented reinstall path** (GO-LIVE §4). Changing its default risks the
   exact grandfathering guarantee this PR exists to protect — a reinstall is the one moment a host `mc.env`
   *is* rewritten.
2. Its **default preset is `shell`** (`PRESET="shell"`, line 28) — the shell executor, whose entire job is to
   run `task.input` as a command. For that preset, `MC_ALLOW_SHELL=1` is functionally required; a global
   flip to `0` would ship a broken default (a shell executor that cannot shell).
3. It already carries an explicit **`--no-shell` opt-out** (line 15/36) — the inverse safety valve. This is a
   CLI installer aimed at a technical operator running a known command, a materially different threat model
   from the general-purpose UI wizard that any operator drives for any new agent.

The sharp edge worth naming (and the reason it stays *flagged*, not silently blessed): the installer's
`ALLOW_SHELL` default is **independent of the chosen preset**, so installing a *non-shell* LLM preset
(`--preset nvidia-minimax`, etc.) still ships `MC_ALLOW_SHELL=1` unless the operator remembers `--no-shell`
— even though those preset `.env` files themselves default `=0`.

> **Recommendation (non-blocking, operator's call):** when the installer is next touched, make `ALLOW_SHELL`
> **track the preset** — default `1` only for the `shell` preset, `0` for the LLM/http presets — with a
> grandfather note that existing installs are unaffected (they re-source their existing `mc.env`). This aligns
> the installer with the registry's safe default *without* breaking the shell-preset use case. Deliberately
> **not** applied in this audit: it changes the live reinstall path's behaviour, which is an operator product
> call, not an auditor's unilateral fix (per audit scope).

---

## 5. Other drift arms swept (`.sh` / `.env` / `.py` / `.ts` / `.md`)

A full-tree sweep for every `MC_ALLOW_SHELL`/`ALLOW_SHELL` default-on found no *hidden* unsafe arm. The
complete inventory:

| Surface | Shell default | Disposition |
|---|---|---|
| `web/lib/adapterProfile.ts` (wizard/Hire) | **off** (opt-in → on) | ✅ Fixed by this change |
| `backend/.../adapter-registry.ts` `openclaw_local.allowShell` | **off** | ✅ Already off, test-locked |
| `adapters/presets/{codex,gemini,nvidia-minimax}.env` | **off** (`=0`) | ✅ Already off |
| `cli/invite.mjs` `mcEnvLines` (ONB6 claim path) | **off** — emits no `MC_ALLOW_SHELL` line at all, so the adapter defaults off | ✅ Already off / consistent |
| `backend/src/services/onboarding-doc.ts` (ONB2 server-rendered doc) | n/a — renders no `mc.env` env lines; only instructs writing the token | ✅ No shell surface |
| `adapters/mac-mini/setup.sh` | **on** (`ALLOW_SHELL="1"`, default preset `shell`) | ⚠️ Flagged product call — §4 |
| `adapters/presets/README.md` `shell.env` example | **on** (`MC_ALLOW_SHELL=1`) | ℹ️ **Intentional** — it documents the *shell executor* preset; shell-on is intrinsic to its purpose, and it is the preset `setup.sh`'s default installs. Consistent with §4, not a separate bug. Newly noted (was not in the builder's flag list). |
| `backend/scripts/smoke-openclaw*.ts` | **on** (`MC_ALLOW_SHELL:'1'`) | ℹ️ Intentional — test harnesses that exercise the shell path; not a shipping surface, inert. |

> **Net: no *new* unsafe drift arm beyond the one the builder already flagged.** The `shell.env` preset doc
> is the only previously-unflagged surface, and it is shell-on *by design* (it is the shell executor). All
> onboarding paths a non-shell agent actually travels — UI wizard, Hire dialog, CLI invite/claim, LLM
> presets, the registry — default **off**.

---

## 6. Test coverage assessment

Adequate and invariant-locking on both sides of the contract:

| Requirement | Covered? |
|---|---|
| New default off | ✅ `[ONB] a new openclaw agent defaults to shell OFF`; `[ONB] custom … defaults OFF` |
| Opt-in flips on | ✅ `[ONB] an operator can opt a new agent INTO shell` (mcEnv **and** runBlock) |
| Non-shell runtimes never emit the flag | ✅ `[ONB] non-shell runtimes never emit MC_ALLOW_SHELL, even when opted in` |
| Registry ↔ wizard agreement | ✅ wizard side (`[ONB] wizard default agrees with the registry`) + registry side (`adapter-registry.test.ts:65`) |
| Existing agent unaffected (grandfathering) | ⚠️ Not a unit test — and **structurally cannot be** one at the web layer: the guarantee is that the wizard writes a copy-paste block and never mutates a host's `mc.env`, plus §1's no-server-gate. Verified by construction, not assertion. Acceptable; noted so a future reader does not "add the missing test" for a property that has no seam to test. |

---

## 7. What this audit changed

- **`docs/AUDIT-shell-default.md`** — this document (the deliverable).

No code changes: the changed code is clean, test-locked, and carries no unambiguous LOW/NIT to fix. The two
residual arms (§4 mac-mini installer, §5 `shell.env` doc) are intentional / deferred product calls left as
**recommendations**, not fixes — flipping either would change adapter behaviour or the live reinstall path,
outside this audit's scope (*"don't touch adapters/telemetry/allowShell defaults beyond what's needed"*).

Backend `1235` + web `13/13` unchanged/green; `main` stays green.

---

## 8. Summary

| Question | Ruling |
|---|---|
| Is enforcement client-side only? (the crux) | **Yes — confirmed empirically.** No server/registry gate reads stored `allowShell`; only the on-host adapter's local `MC_ALLOW_SHELL` gates shell. |
| Is there any server-side shell gate that could break the live agent? | **No.** The `machine_exec` server gate is a separate CC mechanism, not keyed on `allowShell`. |
| Are existing agents grandfathered? | **Yes — automatic, zero-touch, by construction.** |
| New default off + opt-in + registry↔wizard agreement? | **Yes — all verified and test-locked both sides.** |
| Third arm (`mac-mini/setup.sh`)? | **Leave stable + flagged (correct); recommend preset-tracked default as a future non-blocking refinement.** |
| Any other drift arm? | **No new unsafe one.** `shell.env` preset doc is shell-on by design; smoke tests are inert. All real onboarding paths default off. |
| **Verdict** | **PASS.** |
