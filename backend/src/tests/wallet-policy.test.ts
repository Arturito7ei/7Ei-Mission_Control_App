import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyNetwork, resolvePolicy, evaluateWalletPolicy, checkSigningGate,
  assertSigningAllowed, DEFAULT_PER_TX_THRESHOLD_USD, MAINNET_CHAIN_IDS, SIGNER_MODELS,
} from '../services/wallet-policy'

const TESTNET = 11155111 // sepolia
const MAINNET = 1
const OK = { ok: true }
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const ENABLED = { autonomousSigningEnabled: true, mainnetEnabled: false }

// ─── Network classification ──────────────────────────────────────────────────

test('[E2] classifyNetwork: known mainnet ids are mainnet, everything else testnet', () => {
  for (const id of MAINNET_CHAIN_IDS) assert.equal(classifyNetwork(id), 'mainnet')
  assert.equal(classifyNetwork(TESTNET), 'testnet')
  assert.equal(classifyNetwork(80002), 'testnet') // amoy
  assert.equal(classifyNetwork(999999), 'testnet') // unknown → not auto-mainnet
})

test('[E2] resolvePolicy fails closed: signing + mainnet OFF, threshold defaults to $100', () => {
  const p = resolvePolicy(null)
  assert.equal(p.autonomousSigningEnabled, false)
  assert.equal(p.mainnetEnabled, false)
  assert.equal(p.perTxThresholdUsd, DEFAULT_PER_TX_THRESHOLD_USD)
  assert.equal(p.perTxThresholdUsd, 100)
  assert.deepEqual(p.allowlist, [])
})

// ─── Refuse tier (fail-closed) ───────────────────────────────────────────────

test('[E2] refuse when there is no simulation (simulate-before-sign)', () => {
  const r = evaluateWalletPolicy({ valueUsd: 5, spentTodayUsd: 0, chainId: TESTNET, simulation: null, to: A, policy: ENABLED })
  assert.equal(r.decision, 'refuse')
  assert.equal(r.autonomousEligible, false)
})

test('[E2] refuse when the simulation reverts', () => {
  const r = evaluateWalletPolicy({ valueUsd: 5, spentTodayUsd: 0, chainId: TESTNET, simulation: { ok: false }, to: A, policy: ENABLED })
  assert.equal(r.decision, 'refuse')
})

test('[E2] refuse on a drain pattern regardless of value', () => {
  const r = evaluateWalletPolicy({ valueUsd: 1, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, scam: { drainPattern: true }, policy: ENABLED })
  assert.equal(r.decision, 'refuse')
})

// ─── Autonomous tier ─────────────────────────────────────────────────────────

test('[E2] autonomous_sign: small in-policy testnet tx with autonomy enabled', () => {
  const r = evaluateWalletPolicy({ valueUsd: 42, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, policy: ENABLED })
  assert.equal(r.decision, 'autonomous_sign')
  assert.equal(r.autonomousEligible, true)
  assert.equal(r.requiresApproval, false)
  assert.equal(r.network, 'testnet')
})

test('[E2] autonomy is impossible when the master switch is off (default)', () => {
  const r = evaluateWalletPolicy({ valueUsd: 42, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, policy: { autonomousSigningEnabled: false } })
  assert.equal(r.decision, 'require_approval')
  assert.equal(r.autonomousEligible, false)
})

// ─── Approval tier ───────────────────────────────────────────────────────────

test('[E2] value at/above the $100 threshold requires approval + step-up', () => {
  const at = evaluateWalletPolicy({ valueUsd: 100, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, policy: ENABLED })
  assert.equal(at.decision, 'require_approval')
  assert.equal(at.requiresStepUp, true)
  const above = evaluateWalletPolicy({ valueUsd: 250, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, policy: ENABLED })
  assert.equal(above.decision, 'require_approval')
})

test('[E2] just below the threshold is still autonomous', () => {
  const r = evaluateWalletPolicy({ valueUsd: 99.99, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, policy: ENABLED })
  assert.equal(r.decision, 'autonomous_sign')
})

test('[E2] per-day cap forces approval', () => {
  const r = evaluateWalletPolicy({ valueUsd: 40, spentTodayUsd: 80, chainId: TESTNET, simulation: OK, to: A, policy: { ...ENABLED, perDayCapUsd: 100 } })
  assert.equal(r.decision, 'require_approval')
  assert.equal(r.requiresStepUp, true)
})

test('[E2] off-allowlist destination forces approval; on-allowlist stays autonomous', () => {
  const off = evaluateWalletPolicy({ valueUsd: 10, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: B, policy: { ...ENABLED, allowlist: [A] } })
  assert.equal(off.decision, 'require_approval')
  const on = evaluateWalletPolicy({ valueUsd: 10, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, policy: { ...ENABLED, allowlist: [A] } })
  assert.equal(on.decision, 'autonomous_sign')
})

test('[E2] a scam flag (unlimited approval) forces approval even below the value threshold', () => {
  const r = evaluateWalletPolicy({ valueUsd: 1, spentTodayUsd: 0, chainId: TESTNET, simulation: OK, to: A, scam: { unlimitedApproval: true }, policy: ENABLED })
  assert.equal(r.decision, 'require_approval')
  assert.equal(r.requiresStepUp, true)
})

// ─── Mainnet gating (the safety line for this wave) ───────────────────────────

test('[E2] mainnet cannot be autonomous while mainnetEnabled is false', () => {
  const r = evaluateWalletPolicy({ valueUsd: 5, spentTodayUsd: 0, chainId: MAINNET, simulation: OK, to: A, policy: { autonomousSigningEnabled: true, mainnetEnabled: false } })
  assert.equal(r.decision, 'require_approval')
  assert.equal(r.network, 'mainnet')
})

test('[E2] mainnet CAN be autonomous only when BOTH flags are on (post-go-live)', () => {
  const r = evaluateWalletPolicy({ valueUsd: 5, spentTodayUsd: 0, chainId: MAINNET, simulation: OK, to: A, policy: { autonomousSigningEnabled: true, mainnetEnabled: true } })
  assert.equal(r.decision, 'autonomous_sign')
})

// ─── Signing gate (defense-in-depth) ─────────────────────────────────────────

test('[E2] checkSigningGate blocks unless decision=autonomous_sign', () => {
  assert.equal(checkSigningGate({ decision: 'require_approval', chainId: TESTNET, policy: ENABLED }).allowed, false)
  assert.equal(checkSigningGate({ decision: 'refuse', chainId: TESTNET, policy: ENABLED }).allowed, false)
  assert.equal(checkSigningGate({ decision: 'autonomous_sign', chainId: TESTNET, policy: ENABLED }).allowed, true)
})

test('[E2] checkSigningGate blocks mainnet unless mainnetEnabled', () => {
  assert.equal(checkSigningGate({ decision: 'autonomous_sign', chainId: MAINNET, policy: { autonomousSigningEnabled: true, mainnetEnabled: false } }).allowed, false)
  assert.equal(checkSigningGate({ decision: 'autonomous_sign', chainId: MAINNET, policy: { autonomousSigningEnabled: true, mainnetEnabled: true } }).allowed, true)
})

test('[E2] checkSigningGate blocks when autonomy is off', () => {
  assert.equal(checkSigningGate({ decision: 'autonomous_sign', chainId: TESTNET, policy: { autonomousSigningEnabled: false } }).allowed, false)
})

test('[E2] assertSigningAllowed throws on a blocked gate (fail-closed)', () => {
  assert.throws(() => assertSigningAllowed({ decision: 'autonomous_sign', chainId: MAINNET, policy: { autonomousSigningEnabled: true, mainnetEnabled: false } }))
  assert.doesNotThrow(() => assertSigningAllowed({ decision: 'autonomous_sign', chainId: TESTNET, policy: ENABLED }))
})

test('[E2] SIGNER_MODELS documents that WalletConnect cannot do unattended signing', () => {
  assert.equal(SIGNER_MODELS.walletconnect.unattended, false)
  assert.equal(SIGNER_MODELS.local_encrypted_keystore.unattended, true)
  assert.equal(SIGNER_MODELS.delegated_session_key.unattended, true)
})
