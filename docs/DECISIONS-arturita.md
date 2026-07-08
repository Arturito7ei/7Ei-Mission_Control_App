# DECISIONS — Arturita (S1–S6 + standing decisions)

> **Companion to `docs/PRD-arturita.md` (what/why) and `docs/PLAN-arturita.md` (how/stories).** This is the decision log: the pre-build spikes/decisions that gate the first stories, each recorded with its answer, rationale, and what it unblocks.
> **Status legend:** `PROVISIONAL — pending operator confirm` (recommended answer, not yet signed off) · `CONFIRMED (YYYY-MM-DD)` (operator signed off, or already decided in the PRD) · `OPEN` (no recommendation yet).
> **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai)

**How to use this file:** a decision stays `PROVISIONAL` until the operator confirms. A build agent **may proceed on a PROVISIONAL decision** for non-destructive scaffolding, but **must not** ship a dangerous surface (B/C/D/E) whose safety envelope depends on an unconfirmed decision until it is `CONFIRMED`. When the operator confirms, flip the status here and note the date.

> **⚠️ 2026-07-08 DECISION LOCK — S1–S6 all CONFIRMED by the operator at their desk, plus two new requirements.** This flips the whole S-block from provisional to confirmed and records a **material change to the wallet safety model** (S4 below): Arturita moves from *read/prepare/never-sign* to *bounded autonomous signing from a capped burner wallet*, with any transaction at/above ~USD $100 still gated through the A2 approval flow. **Mainnet autonomous signing is NOT enabled in this wave** — testnet + full policy/keystore design only, mainnet behind a final explicit operator go. The two new requirements (distributable packaging + iPhone app) are captured as **Epic H** in `docs/PLAN-arturita.md` and new FR/NFR items in `docs/REQUIREMENTS-arturita.md`.

---

## S1 — STT/TTS provider
**Status:** `CONFIRMED (2026-07-08)`
**Decision:** Ship a **Configuration Setting** with two modes — **`local`** and **`provider`** — **selectable per context** (e.g. sensitive/wallet-adjacent contexts can be pinned to `local`, everyday dictation can use `provider`), wired the same way `llm-router.ts` abstracts LLM providers. The **interim `provider` implementation is Chatterbox TTS via the NVIDIA API.** `local` remains the privacy/offline default for sensitive contexts (whisper.cpp-class STT + a local TTS), per the standing local-first stance.
**Secret handling (done + verified):** the NVIDIA API key belongs in the existing **AES-256-GCM encrypted secrets store** (`secrets.ts`), injected into execution, **never committed to git**. `.env.example` carries only a **placeholder** (`NVIDIA_API_KEY=`). A repo-wide scan (working tree + full git history) on 2026-07-08 confirmed the supplied key value is **not present anywhere in the repo** — no rotation is required for it. (The separate, pre-existing `MC_LLM_API_KEY` NVIDIA-NIM rotation remains a standing GO-LIVE item, unrelated to this key.)
**Rationale:** Voice carries the operator's private context (emails, file names, wallet amounts). A per-context `local|provider` switch keeps sensitive audio off third-party servers by default while allowing higher-quality cloud voice where privacy isn't a concern, with no lock-in. Chatterbox-via-NVIDIA is the fast, good-enough interim cloud voice.
**Unblocks:** B1 (Voice Gateway) config + provider adapter + `/voice` endpoint; therefore B2/B3, D1.
**Follow-through:** the config setting (`local|provider`, per-context) + a Chatterbox/NVIDIA provider adapter + the B1 `/voice` endpoint wiring are the next build items (see PLAN B1/B2). The key is loaded by the operator via **Cockpit → Secrets** (or Fly/agent-secrets injection); it never lands in a prompt/transcript/log/vault (NFR-11).

## S2 — iPhone / remote surface
**Status:** `CONFIRMED (2026-07-08)`
**Decision:** **Telegram-only for v1.** Remote voice/text/files/approvals ride the existing Telegram receiver (`telegram-bot.ts` + `webhook-auth.ts` HMAC). The **operator will provide a Telegram bot token**, wired through the existing HMAC receiver + secrets store (never committed). A **dedicated iPhone app (native/PWA)** is planned for **v2** and is now tracked in **Epic H — Packaging & Distribution** (`docs/PLAN-arturita.md`) alongside the macOS installer.
**Rationale:** Fastest path to remote control, zero App Store latency/review, reuses the hardened per-org HMAC receiver. The native/PWA client is real future scope but sequenced after the flows settle — captured in Epic H so it is not lost.
**Unblocks:** D1/D2 (with `WEBHOOK_SIGNING_SECRET` set + the bot token loaded).
**Needs from operator (go-live):** provide the Telegram bot token (→ secrets store), set `WEBHOOK_SIGNING_SECRET`, complete the one-time bind.

## S3 — Mac-control adapter approach + access scope
**Status:** `CONFIRMED (2026-07-08)` *(safety-critical — now unblocked for C-epic host build, with the revised envelope below)*
**Decision:** Build the **custom hardened local daemon** (`adapters/arturita-host/`, sibling to `adapters/mac-mini/`) for the read/preview/write/exec path. **The operator grants FULL machine access** — installing Arturita / 7Ei Mission Control **assumes full control of the given machine**, so the **allowlist root is effectively the whole machine**. What changes vs the earlier draft is the *default posture*: from "small allowlist root" to "whole machine allowed, minimal denylist."
**Minimal hard denylist (self-protection ONLY — not general safety):** the daemon still hard-refuses read *and* write on a short list whose only purpose is to stop Arturita harming herself or bricking the host:
- **Arturita's own secret store / signing material** — the AES-256-GCM secret store backing file(s), the burner wallet **keystore** (S4), and the daemon's own credentials/config. She must never be able to exfiltrate or overwrite her own signing key.
- **OS system-integrity paths** — SIP-protected system locations and anything whose corruption bricks the OS (e.g. `/System`, `/usr` (non-`/usr/local`), boot/firmware paths). She runs as the operator user, no sudo.
- Everything else on the machine is **permitted**.
**Still gated:** even with the whole machine allowed, **destructive/irreversible operations still render a machine-generated verbatim approval summary through the A2 gate** and require the two-phase confirm (delete/move/overwrite outside a safe cap). Blast-radius caps still produce a preview manifest + undo journal; the daemon is still **fail-closed** (acts only on an authenticated, approved backend command). Path canonicalization (`..`/symlink-escape) still applies — it now enforces the denylist boundary rather than an allowlist boundary.
**Open sub-choices (resolve in the C1 daemon build):** (a) daemon language — Node (matches the repo) vs a small Swift/Go helper for native macOS APIs; (b) auth channel — mTLS vs signed local socket. First-run macOS TCC permission grants (Full Disk Access, Accessibility, Automation, Microphone) are handled by the Epic H permission wizard.
**Rationale:** the operator explicitly wants a full chief-of-staff with real machine reach; a whole-machine root maximizes usefulness. The residual risk (a compromised model with broad reach) is bounded by: (1) the self-protection denylist so she can't steal her own key or brick the OS, (2) the A2 approval gate + two-phase confirm on every destructive/irreversible op, (3) the undo journal, (4) fail-closed + no-sudo, and (5) full auditability (every host action is a task + thread + heartbeat).
**Unblocks:** C1 (Local Host daemon), and therefore C2/C3, D2.

## S4 — Wallet safety model — **CHANGED: bounded autonomous signing from a capped burner** ⚠️
**Status:** `CONFIRMED (2026-07-08)` — **this is a material change to a prior invariant; read in full.**

> **What changed.** The earlier invariant was **"never sign / no key custody, ever"** (read + prepare + simulate; the operator signs in the wallet UI). The operator has **overridden** this: Arturita is to have **full control of a dedicated wallet**, **funded only with what she may spend**, so the **downside is capped by the balance**. She may transact **autonomously up to a per-tx spend limit**; **anything at/above ~USD $100 equivalent requires explicit operator approval through the A2 gate.** See the updated PRD invariants (§2/§7.4) and the residual-risk note there.

**Decision (design + policy for this wave — NO mainnet autonomous signing yet):**
- **Dedicated low-balance hot wallet (burner).** A separate burner wallet, **distinct from the operator's main wallet**, funded with a small capped balance. Capped funding = capped maximum loss (the rationale for allowing autonomy at all).
- **Local signer / session key (WalletConnect alone is insufficient).** Autonomous signing below the threshold requires a **local signer**: plain **WalletConnect cannot do unattended signing** (it always defers to the wallet UI for a human tap). So the design uses either **(a) a local encrypted keystore** (the burner's key sealed in the AES-256-GCM store / an OS keychain-backed keystore, decrypted only in-process at signing time) **or (b) a delegated session key** (e.g. a smart-account session key / ERC-4337-style delegation) **with an on-chain or policy-enforced cap.** Preference: whichever keeps the blast radius smallest for the same UX — a session key with an enforced cap is safer than a raw hot key if the target chain/wallet supports it; otherwise a local encrypted keystore for the burner only.
- **Policy engine (build this wave, testnet-enforced):**
  - **Per-tx threshold** — default **USD $100**, operator-configurable. **< threshold → Arturita may sign autonomously; ≥ threshold → routes to the A2 `wallet_tx` approval path** (operator confirms; never voice-alone for value — NFR-5).
  - **Per-day cap** — cumulative USD limit; exceeding it forces approval regardless of per-tx size.
  - **Destination allowlist** — configurable; higher amounts / off-allowlist destinations require step-up.
  - **Scam guards** carry over (new-address / `setApprovalForAll` / unlimited-approval / drain-pattern — `detectScamSignals`).
- **Keystore plumbing + testnet path only.** Build the full design + policy engine + burner-keystore plumbing + a **testnet** signing path. **Do NOT enable real MAINNET autonomous signing in this wave.** Mainnet stays behind a **final explicit operator go + a funded wallet**, guarded by a hard default flag (e.g. `WALLET_AUTONOMOUS_SIGNING_ENABLED=false`, `WALLET_MAINNET_ENABLED=false`).
- **Key hygiene (unchanged, absolute):** the burner private key is **never exposed or logged**, never enters a prompt/transcript/vault, and is denylisted from the host daemon (S3). The `assertNoKeyMaterial` guard stays; what changes is that a **sealed** key may now exist in the encrypted keystore for the burner — it is never in plaintext at rest and never leaves the signing boundary.

**Rationale:** the operator wants genuine autonomous spend for small amounts (a working treasury for a chief-of-staff), accepting that the **maximum loss is bounded by the burner balance**. The ≥$100 approval gate keeps every material transaction human-in-the-loop; the burner separation keeps the main wallet untouched; testnet-first + the disabled mainnet flag keep this wave safe.
**Residual risk (documented, accepted for the capped amount):** a compromised model or a mis-simulated tx could lose **up to the burner balance and the per-day cap** autonomously (below the $100 per-tx line) before any human sees it. Mitigations: keep the burner balance and per-day cap small, keep the per-tx threshold conservative, allowlist destinations, retain scam guards + simulation-before-sign, and log every autonomous tx as a visible task. This risk did not exist under the old never-sign model and is the explicit trade for autonomy.
**Unblocks:** E2 (now: policy engine + burner keystore design + testnet signing path + the `wallet_tx` ≥threshold approval card). E1 (read/prepare/simulate) is unchanged and already shipped.
**Needs from operator (go-live, before any mainnet):** fund + name the burner wallet (MetaMask or Brave), a testnet + testnet-funded wallet for the build, confirm per-tx threshold ($100 default) / per-day cap / destination allowlist values, and the **final explicit go** to flip mainnet autonomous signing on.

## S5 — Wake-word vs push-to-talk
**Status:** `CONFIRMED (2026-07-08)`
**Decision:** **Push-to-talk by default; wake-word ("Arturita") opt-in.**
**Rationale:** Always-listening is a standing privacy cost (a hot mic in the operator's office/home); push-to-talk is an explicit, auditable capture. Wake-word remains available for hands-free use as an opt-in.
**Unblocks:** B2 (Cockpit voice panel default behavior). Pure helpers (`shouldProcessCapture`, `hasWakeWord`) already encode this.
**Needs from operator:** none — confirmed.

## S6 — `machine_exec` scope at launch
**Status:** `CONFIRMED (2026-07-08)` *(safety-critical — revised to broad-exec-allowed, still gated for destructive)*
**Decision:** **Full control assumed → broad exec allowed** (consistent with S3's whole-machine access). This **supersedes** the earlier "empty allowlist at launch" recommendation. Arturita may run commands on the operator's machine. **However:** any **destructive/irreversible command still routes through the A2 approval gate** with the **two-phase confirm** and the exact `argv` shown verbatim. Non-destructive commands run without a per-command approval; the daemon's fail-closed + denylist (S3) + blast-radius classification still bound what "non-destructive" means.
**Rationale:** the operator wants a genuinely capable chief-of-staff, not a locked-down shell. Safety comes from gating the *irreversible* subset (destructive file ops, anything over the blast-radius cap, anything touching the denylist) rather than from a near-empty allowlist. `argv` is always shown verbatim in any approval so a misheard/mis-planned command can't execute silently.
**Unblocks:** C3 (`machine_exec` + doc editing).
**Needs from operator:** none to launch broad exec; optionally provide a *denylist* of commands to always-gate beyond the destructive-intent classifier.

---

## Standing decisions
| # | Decision | Source | Status |
|---|---|---|---|
| D-a | ~~**No key custody, ever**~~ **SUPERSEDED by S4 (2026-07-08).** Arturita now holds a **sealed burner key** in the encrypted keystore for **bounded autonomous signing** (< per-tx threshold; testnet this wave). Key material is never in plaintext at rest, never logged, never in a prompt/transcript/vault, and denylisted from the host daemon. ≥ threshold still routes to human approval. | PRD §2, §7.4 (updated) · S4 | `CHANGED (2026-07-08)` |
| D-b | **Every dangerous action gates through the existing tri-state approval flow** (`file_destructive`/`wallet_tx`/`email_send`/`machine_exec`) with step-up. Under S4, `wallet_tx` fires at/above the per-tx threshold; under S6, destructive/irreversible `machine_exec` fires regardless. | PRD §7.1, PLAN A2 | `CONFIRMED` |
| D-c | **Safety spine (Epic A) ships before any dangerous surface;** `machine_exec` (C3) + wallet **mainnet** signing (E2) are last and stay behind explicit go flags. | PRD §10, PLAN §2 | `CONFIRMED` |
| D-d | **Single operator only** — Arturita is owner-scoped, not multi-tenant, in v1. | PRD §2 | `CONFIRMED` |
| D-e | **Voice audio discarded after transcription** — no long-term audio store; transcripts live in the (deletable) task thread. | PRD §7.8 | `CONFIRMED` |
| D-f | **`WEBHOOK_SIGNING_SECRET` is a hard prerequisite** for enabling Telegram remote control (receivers must be HMAC-enforced, not open). | PRD §11, §7.1 | `CONFIRMED` |
| D-g | **LLM failover is cost-bounded** — every retry re-runs the preflight per-wake cap. | PRD §6 | `CONFIRMED` |
| D-h | **Distributable packaging is v1 scope** — macOS installable bundle (signed + notarized), first-run TCC permission wizard, auto-update, fresh-machine config/secret bootstrap, and the iPhone remote surface (v1 Telegram, v2 native/PWA). Design/plan this wave; build later. | S2 + operator (2026-07-08) | `CONFIRMED` (Epic H) |
| D-i | **Vault graph uses Graphify as the richer backend, native parse as fallback** — the Memory tab prefers a committed `graphify-out/graph.json`; when absent, the backend parses the vault's markdown ([[wikilinks]]/#tags/frontmatter) itself. No hard runtime dependency on Graphify. | Operator request (2026-07-08) · Epic M | `CONFIRMED` |

---

## S-M1 — Graphify semantic pass: run it, and with which provider/key? `[OPEN — operator decision]`
**Status:** `OPEN (2026-07-08)` — **needs operator sign-off before any spend.**
**Context:** Graphify builds the vault graph in two passes. The **structural/AST pass** (tree-sitter, `graphify update <root> --no-cluster`) is **local and free** — this is what shipped: it produced **786 nodes / 964 edges** from the 128-note TARCO vault (`vault/graphify-out/graph.json`), rendering fully in the Memory tab. The **semantic pass** (community naming / richer relations) calls an **AI API and costs money + needs a key**.
**What I found:** **no standalone LLM API key** is present in the build environment (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY` all unset — only the Claude Code OAuth proxy, not usable by Graphify as a plain key). A **local Ollama** is running (free, no external key) and could name communities at zero API cost, but *which* local model + whether that quality is wanted is an operator preference.
**Decision needed from operator (pick one):**
1. **Leave structural-only** (default, $0) — the graph already works; skip semantic naming. *(Recommended for now.)*
2. **Local Ollama** (`graphify cluster-only <root> --backend=ollama --model=<name>`) — $0 API cost, local only; name the model.
3. **Cloud provider** — supply/confirm a key (`GEMINI_API_KEY` cheapest) and I'll run `graphify cluster-only`/`label`. Rough cost: a 128-note / ~30k-word vault is a **single small pass — cents, not dollars** on Gemini Flash.
**Guardrail honored:** no key was committed; no semantic pass was run unprompted. See `docs/REQUIREMENTS-arturita.md` NFR-28.

---

_Linked from `docs/PLAN-arturita.md` §3 and `HANDOFF.md`. All S-decisions confirmed 2026-07-08. The S4 wallet-model change and the D-h packaging decision cascade into the PRD invariants, PLAN (Epic E revised + Epic H new), and REQUIREMENTS (new FR/NFR items)._
