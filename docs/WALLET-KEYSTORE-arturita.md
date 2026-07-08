# Arturita wallet — burner keystore & signer design (E2 / S4)

> **Status:** design of record for the E2 signing path · **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai)
> **Companions:** `docs/DECISIONS-arturita.md` (S4), `docs/PRD-arturita.md` §7.4, `backend/src/services/wallet-policy.ts` (the pure policy engine + fail-closed signing gate).

This documents *how* Arturita signs autonomously for the capped-burner model, and — just as importantly — the guarantees that keep the blast radius bounded and keep **mainnet autonomous signing OFF this wave**. It is design + plumbing; the live signer is a go-live wiring item (needs the operator's funded testnet wallet + the final signer-library choice).

## 1. Why a keystore at all (WalletConnect is insufficient)

Plain **WalletConnect always defers to a human tap** in the wallet UI — it cannot sign unattended. The operator's S4 decision requires **autonomous** signing below the per-tx threshold, so Arturita needs a signer she can invoke without a human. Two candidate models (see `SIGNER_MODELS` in `wallet-policy.ts`):

| Model | Unattended? | Key at rest | Blast radius | Notes |
|---|---|---|---|---|
| **Local encrypted keystore** | ✅ | Sealed (AES-256-GCM secret store, OS-keychain-backed where possible); decrypted only in-process at signing time | The whole burner balance | Simplest; works on any EVM chain. Preferred fallback. |
| **Delegated session key** (smart-account / ERC-4337) | ✅ | A revocable session key with an on-chain/policy cap | Bounded to the session-key cap even if leaked | **Preferred where the target chain/wallet supports it** — smallest blast radius. |
| **WalletConnect** | ❌ | Wallet holds the key | n/a | Only usable for the **≥-threshold approval** path (human taps in MetaMask/Brave). |

**Decision:** prefer a **delegated session key with an enforced cap** when the chain/wallet supports it; otherwise a **local encrypted keystore** for the burner only. Resolve the final choice during the E2 build against the chosen testnet.

## 2. Hard invariants (must hold in code + review)

1. **Dedicated burner only.** The signer key is a **burner wallet distinct from the operator's main wallet**, funded with a small capped balance. Capped funding = capped maximum autonomous loss.
2. **Never plaintext at rest.** The key is sealed in the AES-256-GCM store (`secrets.ts`) / OS keychain. No plaintext key file, ever. Nothing committed to git.
3. **Never logged / never in a prompt / never in the vault.** The key never enters an LLM prompt, transcript, log line, telemetry, or the Obsidian vault. `assertNoKeyMaterial` guards everything persisted to `wallet_intents`.
4. **Never an API input or output.** No endpoint accepts or returns a private key. The signer boundary decrypts → signs → zeroizes in-process; only the resulting `signed_txhash` leaves.
5. **Denylisted from the host daemon (S3).** The keystore path is on the host daemon's self-protection denylist — Arturita's file/exec surface cannot read or overwrite her own signing key.
6. **Fail-closed signing gate.** Every signing call goes through `checkSigningGate()` / `assertSigningAllowed()`: signing is allowed **only** when the policy decision is `autonomous_sign` **and** `autonomousSigningEnabled` **and** (network is testnet **or** `mainnetEnabled`). All three default off → **no accidental mainnet sign is possible this wave.**
7. **Simulate before sign.** A tx that lacks a simulation or would revert is refused, not signed (policy engine, FR-24a).

## 3. Policy engine (shipped — `wallet-policy.ts`)

Pure decision layer; holds no key, does no network I/O.

- `evaluateWalletPolicy(...)` → `autonomous_sign | require_approval | refuse`, with `requiresStepUp`.
  - **refuse:** no/failed simulation, or a drain pattern.
  - **require_approval:** value ≥ per-tx threshold (default **$100**), over per-day cap, off destination allowlist, any scam flag (`setApprovalForAll` / unlimited approval / new address / unknown contract), autonomy disabled, or mainnet-not-enabled.
  - **autonomous_sign:** small, in-policy, simulated OK, testnet (or mainnet explicitly enabled).
- `checkSigningGate(...)` / `assertSigningAllowed(...)` — the defense-in-depth gate above.
- Config lives in the `wallet_policy` table (`per_tx_threshold_usd`, `per_day_cap_usd`, `allowlist`, `autonomous_signing_enabled` default 0, `mainnet_enabled` default 0) — set via `PUT /api/orgs/:orgId/arturita/wallet/policy`. **No key material in this table.**

## 4. Signing flow (E2 build, testnet)

```
prepare (E1) → simulate (E1) → POST …/wallet/:id/evaluate (policy)
   ├─ refuse            → say why, stop
   ├─ require_approval  → raise an A2 `wallet_tx` approval (decoded summary + caps + scam guards);
   │                       operator confirms; then sign via the same gate (fresh session / step-up)
   └─ autonomous_sign   → assertSigningAllowed() → signer boundary:
                            decrypt session/burner key in-process → sign the simulated tx →
                            broadcast to the TESTNET RPC → record signed_txhash → task + heartbeat
```

Every signed tx (autonomous or approved) becomes a **visible task** with a thread + heartbeat block (no silent action). The autonomous path is testnet-only until `WALLET_MAINNET_ENABLED=true` **and** a final explicit operator go.

## 5. Go-live checklist (operator, before any mainnet)

- [ ] Create + fund a **dedicated burner** (MetaMask or Brave), separate from the main wallet, with a small capped balance.
- [ ] Choose the signer model (session key vs local encrypted keystore) for the target chain.
- [ ] Set RPC endpoints (testnet first) in the secret store.
- [ ] Configure the policy: per-tx threshold ($100 default), per-day cap, destination allowlist.
- [ ] Seal the burner key in the encrypted store; confirm it is denylisted from the host daemon.
- [ ] Run the full flow on **testnet** end-to-end.
- [ ] Only then: flip `WALLET_MAINNET_ENABLED` + `WALLET_AUTONOMOUS_SIGNING_ENABLED` with an explicit go, on a funded burner.

## 6. Residual risk (accepted for the capped amount)

Below the $100 line, a compromised model or a mis-simulated tx could lose **up to the burner balance / per-day cap** autonomously before a human sees it. Mitigated by: small balances, conservative per-tx/per-day caps, destination allowlist, scam guards, simulate-before-sign, testnet-first, the fail-closed gate, and per-tx task auditability. This is the explicit trade for autonomy and did not exist under the prior never-sign model.
