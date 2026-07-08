// Arturita E2 — wallet POLICY ENGINE + signer-model design (pure).
//
// ⚠️ WALLET SAFETY-MODEL CHANGE (S4, 2026-07-08). The prior model was
// read+prepare+simulate, NEVER sign, no key custody. The operator overrode it:
// Arturita may now sign AUTONOMOUSLY from a DEDICATED CAPPED BURNER wallet for
// small amounts (below a per-tx threshold, default USD $100); any tx at/above
// the threshold still routes to the operator through the A2 `wallet_tx`
// approval. Downside is bounded by the burner balance (capped funding = capped
// loss). See docs/DECISIONS-arturita.md S4 and PRD §7.4.
//
// This module is the PURE decision layer — it holds NO key, does NO signing, and
// touches NO network. It decides, for a prepared+simulated intent and a policy:
//   autonomous_sign | require_approval | refuse
// and it exposes the fail-closed guards that keep MAINNET autonomous signing OFF
// this wave (testnet only; mainnet behind an explicit operator go flag).
//
// The real signer (a local encrypted keystore or a delegated session key) lives
// behind `assertSigningAllowed()` in the route/keystore layer — WalletConnect
// alone CANNOT do unattended signing, so the design needs a local sealed key or
// a policy-capped session key. See docs/WALLET-KEYSTORE-arturita.md.

import { normalizeAddress } from './wallet'

// ─── Networks ────────────────────────────────────────────────────────────────

// Known EVM MAINNET chain ids. Anything not here is treated as a testnet/dev net
// for policy purposes (fail SAFE for the "is this mainnet?" question — an unknown
// chain is NOT auto-classified as mainnet, but mainnet signing is independently
// gated by `mainnetEnabled` so misclassification can't enable a real-fund sign).
export const MAINNET_CHAIN_IDS = new Set<number>([
  1,      // Ethereum
  10,     // Optimism
  56,     // BNB Smart Chain
  137,    // Polygon PoS
  8453,   // Base
  42161,  // Arbitrum One
  43114,  // Avalanche C-Chain
])

export type WalletNetwork = 'mainnet' | 'testnet'

export function classifyNetwork(chainId: number): WalletNetwork {
  return MAINNET_CHAIN_IDS.has(Number(chainId)) ? 'mainnet' : 'testnet'
}

// ─── Policy config ───────────────────────────────────────────────────────────

/** Default per-tx autonomy threshold (USD). Below → may sign autonomously;
 *  at/above → operator approval (A2). Operator-configurable. */
export const DEFAULT_PER_TX_THRESHOLD_USD = 100

export interface WalletPolicy {
  /** Autonomy line (USD). Tx value < threshold may be signed autonomously;
   *  >= threshold routes to approval. Default $100. */
  perTxThresholdUsd?: number | null
  /** Cumulative autonomous spend cap (USD) per day; exceeding it forces approval. */
  perDayCapUsd?: number | null
  /** Destination allowlist. When non-empty, an off-allowlist destination forces
   *  approval. Empty = no allowlist restriction (autonomy still bounded by caps). */
  allowlist?: string[] | null
  /** Master switch: autonomous signing is impossible unless true (default false). */
  autonomousSigningEnabled?: boolean
  /** Mainnet switch: real mainnet signing is impossible unless true (default
   *  false). Testnet does not need this. Kept off this wave. */
  mainnetEnabled?: boolean
}

/** Fill a partial policy with fail-closed defaults (signing OFF, mainnet OFF). */
export function resolvePolicy(p: WalletPolicy | null | undefined): Required<WalletPolicy> {
  const pol = p ?? {}
  return {
    perTxThresholdUsd: pol.perTxThresholdUsd ?? DEFAULT_PER_TX_THRESHOLD_USD,
    perDayCapUsd: pol.perDayCapUsd ?? null,
    allowlist: (pol.allowlist ?? []).map(a => normalizeAddress(a)).filter(Boolean) as string[],
    autonomousSigningEnabled: pol.autonomousSigningEnabled === true,
    mainnetEnabled: pol.mainnetEnabled === true,
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

export type PolicyDecision = 'autonomous_sign' | 'require_approval' | 'refuse'

export interface PolicyScamInput {
  drainPattern?: boolean
  setApprovalForAll?: boolean
  unlimitedApproval?: boolean
  newAddress?: boolean
  unknownContract?: boolean
}

export interface PolicyEvaluation {
  decision: PolicyDecision
  network: WalletNetwork
  /** true when the tx must go to the operator (A2 wallet_tx approval). */
  requiresApproval: boolean
  /** true when the approval must be step-up (fresh session / distinct factor). */
  requiresStepUp: boolean
  /** true only when Arturita may sign without a human (bounded, in-policy). */
  autonomousEligible: boolean
  threshold: number
  reasons: string[]
}

/** Evaluate a prepared+simulated intent against a policy. FAIL-CLOSED precedence:
 *  1. no/failed simulation → refuse (simulate-before-sign, FR-24a).
 *  2. drain pattern → refuse (never sign a drain).
 *  3. any approval trigger (>= threshold, over per-day, off-allowlist, a scam
 *     flag, autonomy disabled, or mainnet-not-enabled) → require_approval.
 *  4. otherwise → autonomous_sign.
 *  Pure: no key, no network. */
export function evaluateWalletPolicy(input: {
  valueUsd: number
  spentTodayUsd: number
  chainId: number
  /** simulation summary; null = never simulated. `ok:false` = would revert. */
  simulation: { ok: boolean } | null | undefined
  scam?: PolicyScamInput | null
  to: string
  policy: WalletPolicy | null | undefined
}): PolicyEvaluation {
  const pol = resolvePolicy(input.policy)
  const network = classifyNetwork(input.chainId)
  const scam = input.scam ?? {}
  const reasons: string[] = []
  const threshold = pol.perTxThresholdUsd ?? DEFAULT_PER_TX_THRESHOLD_USD

  // 1. Simulate-before-sign (refuse — do not even offer for approval).
  if (!input.simulation) {
    reasons.push('No simulation — refusing (simulate-before-sign, FR-24a).')
    return refuse(network, threshold, reasons)
  }
  if (input.simulation.ok === false) {
    reasons.push('Simulation reverts — refusing (would fail on-chain, FR-24a).')
    return refuse(network, threshold, reasons)
  }
  // 2. Drain pattern → never.
  if (scam.drainPattern) {
    reasons.push('Drain pattern detected — refusing outright.')
    return refuse(network, threshold, reasons)
  }

  // 3. Approval triggers.
  const overThreshold = input.valueUsd >= threshold
  if (overThreshold) reasons.push(`Value $${round2(input.valueUsd)} ≥ per-tx threshold $${threshold} — operator approval required.`)

  const overPerDay = pol.perDayCapUsd != null && input.spentTodayUsd + input.valueUsd > pol.perDayCapUsd
  if (overPerDay) reasons.push(`Would exceed per-day cap $${pol.perDayCapUsd} (today $${round2(input.spentTodayUsd)} + $${round2(input.valueUsd)}).`)

  const to = normalizeAddress(input.to)
  const offAllowlist = pol.allowlist.length > 0 && !(to != null && pol.allowlist.includes(to))
  if (offAllowlist) reasons.push('Destination not on the allowlist — operator approval required.')

  const scamFlag = !!(scam.setApprovalForAll || scam.unlimitedApproval || scam.newAddress || scam.unknownContract)
  if (scam.setApprovalForAll) reasons.push('setApprovalForAll — approval required.')
  if (scam.unlimitedApproval) reasons.push('Unlimited approval — approval required.')
  if (scam.newAddress) reasons.push('Never-before-seen destination — approval required.')
  if (scam.unknownContract) reasons.push('Unknown/unlabeled contract — approval required.')

  const autonomyDisabled = !pol.autonomousSigningEnabled
  if (autonomyDisabled) reasons.push('Autonomous signing is disabled (WALLET_AUTONOMOUS_SIGNING_ENABLED=false) — approval required.')

  const mainnetBlocked = network === 'mainnet' && !pol.mainnetEnabled
  if (mainnetBlocked) reasons.push('Mainnet autonomous signing is disabled this wave — operator approval required (testnet only).')

  const requiresApproval = overThreshold || overPerDay || offAllowlist || scamFlag || autonomyDisabled || mainnetBlocked
  if (requiresApproval) {
    // Step-up for the *material* triggers (value / scam / off-allowlist), not for
    // the mere "autonomy switch off" case.
    const requiresStepUp = overThreshold || overPerDay || offAllowlist || scamFlag
    return {
      decision: 'require_approval', network, requiresApproval: true, requiresStepUp,
      autonomousEligible: false, threshold, reasons,
    }
  }

  // 4. Autonomous — bounded + in-policy + testnet (or mainnet explicitly enabled).
  reasons.push(`Autonomous sign OK: $${round2(input.valueUsd)} < $${threshold}, in-policy, ${network}.`)
  return {
    decision: 'autonomous_sign', network, requiresApproval: false, requiresStepUp: false,
    autonomousEligible: true, threshold, reasons,
  }
}

function refuse(network: WalletNetwork, threshold: number, reasons: string[]): PolicyEvaluation {
  return { decision: 'refuse', network, requiresApproval: false, requiresStepUp: false, autonomousEligible: false, threshold, reasons }
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

// ─── Signing gate (fail-closed; keeps mainnet OFF this wave) ──────────────────

export interface SigningGate {
  allowed: boolean
  reason: string
}

/** The hard gate the signing path MUST call before touching the keystore. Signing
 *  is allowed ONLY when autonomy is enabled AND (the network is testnet OR mainnet
 *  is explicitly enabled) AND the policy decision is `autonomous_sign`. Anything
 *  else fails closed. This is defense-in-depth on top of `evaluateWalletPolicy` so
 *  a real mainnet sign is impossible without both flags + an explicit decision. */
export function checkSigningGate(input: {
  decision: PolicyDecision
  chainId: number
  policy: WalletPolicy | null | undefined
}): SigningGate {
  const pol = resolvePolicy(input.policy)
  const network = classifyNetwork(input.chainId)
  if (input.decision !== 'autonomous_sign') {
    return { allowed: false, reason: `signing blocked: policy decision is "${input.decision}", not autonomous_sign` }
  }
  if (!pol.autonomousSigningEnabled) {
    return { allowed: false, reason: 'signing blocked: WALLET_AUTONOMOUS_SIGNING_ENABLED=false' }
  }
  if (network === 'mainnet' && !pol.mainnetEnabled) {
    return { allowed: false, reason: 'signing blocked: mainnet disabled this wave (WALLET_MAINNET_ENABLED=false)' }
  }
  return { allowed: true, reason: `signing allowed (${network})` }
}

/** Throwing form for the fail-closed call site. */
export function assertSigningAllowed(input: {
  decision: PolicyDecision
  chainId: number
  policy: WalletPolicy | null | undefined
}): void {
  const gate = checkSigningGate(input)
  if (!gate.allowed) throw new Error(gate.reason)
}

// ─── Signer-model design note (documentation, not execution) ──────────────────

/** The burner signer approaches, for the E2 keystore build. WalletConnect can't
 *  do unattended signing, so autonomy needs one of these. Returned for the
 *  cockpit/CLI/docs to display; contains NO key material. */
export const SIGNER_MODELS = {
  local_encrypted_keystore: {
    id: 'local_encrypted_keystore',
    summary: 'Burner private key sealed in the AES-256-GCM secret store (OS-keychain-backed where possible); decrypted only in-process at signing time.',
    unattended: true,
    keyAtRest: 'sealed (never plaintext)',
  },
  delegated_session_key: {
    id: 'delegated_session_key',
    summary: 'A smart-account / ERC-4337-style session key with an on-chain or policy-enforced cap; smallest blast radius when the chain/wallet supports it.',
    unattended: true,
    keyAtRest: 'session key (revocable, capped)',
  },
  walletconnect: {
    id: 'walletconnect',
    summary: 'Presents a tx to MetaMask/Brave for a HUMAN tap. Cannot do unattended signing — usable only for the >=threshold approval path.',
    unattended: false,
    keyAtRest: 'n/a (wallet holds the key)',
  },
} as const
