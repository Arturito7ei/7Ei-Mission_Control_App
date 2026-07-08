// Arturita E1 routes — wallet READ + PREPARE + SIMULATE. Clerk-secured.
//
// There is deliberately NO signing endpoint: Arturita constructs an unsigned tx,
// decodes it, checks caps + scam signals, and stores a `wallet_intent`. The
// operator signs in their wallet UI (E2, via WalletConnect). No key custody, ever
// (PRD §7.4) — `assertNoKeyMaterial` guards every persisted field.
//
// The raw RPC I/O (balance reads, eth_call/estimateGas simulation) is the route's
// job once an RPC endpoint is configured; for now `prepare` assembles from the
// caller-supplied fields and `simulate` interprets a caller-supplied raw result,
// so the whole path is testable and shippable without live keys. E2 (approval
// card + WalletConnect handoff) stays blocked on decision S4.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { documentEndpoint } from '../services/openapi'
import {
  buildUnsignedTx, decodeCalldata, detectScamSignals, checkCaps,
  summarizeSimulation, weiToEth, shortAddress, assertNoKeyMaterial,
} from '../services/wallet'
import {
  evaluateWalletPolicy, checkSigningGate, resolvePolicy, classifyNetwork,
  DEFAULT_PER_TX_THRESHOLD_USD, SIGNER_MODELS,
} from '../services/wallet-policy'

const PrepareBody = z.object({
  chain: z.string().min(1),
  chainId: z.number().int(),
  from: z.string().min(1),
  to: z.string().min(1),
  valueWei: z.string().optional(),
  data: z.string().optional(),
  kind: z.string().optional(),
  contractLabel: z.string().optional(),
  contractLabeled: z.boolean().optional(),
  knownAddresses: z.array(z.string()).optional(),
  valueUsd: z.number().optional(),
  spentTodayUsd: z.number().optional(),
  caps: z.object({
    perTxUsd: z.number().nullable().optional(),
    perDayUsd: z.number().nullable().optional(),
    allowlist: z.array(z.string()).nullable().optional(),
  }).optional(),
})

const SimulateBody = z.object({
  reverted: z.boolean().optional(),
  revertReason: z.string().nullable().optional(),
  gasUsed: z.union([z.string(), z.number()]).nullable().optional(),
  gasPriceWei: z.union([z.string(), z.number()]).nullable().optional(),
  ethUsd: z.number().nullable().optional(),
})

// E2 (S4) — wallet policy config. NEVER any key material here (the burner key is
// sealed in the secret store). Both switches default false = fail closed.
const PolicyBody = z.object({
  perTxThresholdUsd: z.number().nullable().optional(),
  perDayCapUsd: z.number().nullable().optional(),
  allowlist: z.array(z.string()).nullable().optional(),
  autonomousSigningEnabled: z.boolean().optional(),
  mainnetEnabled: z.boolean().optional(),
})

const EvaluateBody = z.object({
  chainId: z.number().int(),
  valueUsd: z.number(),
  spentTodayUsd: z.number().optional(),
  simulated: z.boolean().optional(), // override; else read the intent's sim result
  scam: z.object({
    drainPattern: z.boolean().optional(),
    setApprovalForAll: z.boolean().optional(),
    unlimitedApproval: z.boolean().optional(),
    newAddress: z.boolean().optional(),
    unknownContract: z.boolean().optional(),
  }).optional(),
})

export async function arturitaWalletRoutes(app: FastifyInstance) {
  // Prepare an UNSIGNED tx: build it, decode calldata, run scam guards + caps,
  // and persist a wallet_intent. No approval + no signing here (that's E2).
  app.post('/api/orgs/:orgId/arturita/wallet/prepare', async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof PrepareBody>
    try { b = PrepareBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    let unsigned
    try {
      unsigned = buildUnsignedTx({ from: b.from, to: b.to, chainId: b.chainId, valueWei: b.valueWei ?? '0', data: b.data })
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'could not build tx' })
    }

    const decoded = decodeCalldata(b.data ?? '0x')
    const scam = detectScamSignals({
      decoded, to: b.to, knownAddresses: b.knownAddresses ?? [],
      contractLabeled: b.contractLabeled ?? !!b.contractLabel,
    })
    const caps = checkCaps({
      valueUsd: b.valueUsd ?? 0, to: b.to, spentTodayUsd: b.spentTodayUsd ?? 0, caps: b.caps ?? null,
    })

    const ethPart = b.valueWei && b.valueWei !== '0' ? `${weiToEth(b.valueWei)} (native) → ` : ''
    const label = b.contractLabel ? ` · ${b.contractLabel}` : ''
    const decodedSummary = `[${b.chain}] ${ethPart}${decoded.method} → ${shortAddress(b.to)}${label}`
    const warnings = [...scam.warnings, ...caps.reasons]

    // NFR-2: nothing we persist may carry key material.
    try {
      assertNoKeyMaterial({ decodedSummary, contractLabel: b.contractLabel ?? '', data: b.data ?? '' })
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message })
    }

    const id = randomUUID()
    const row = {
      id, orgId, chain: b.chain, kind: b.kind ?? decoded.method.split('(')[0], toAddress: b.to,
      valueWei: unsigned.value, decodedSummary, unsignedTx: unsigned as any,
      simResult: null, capsCheck: caps as any, warnings, status: 'prepared',
      approvalId: null, signedTxhash: null, createdAt: new Date(),
    }
    await db.insert(schema.walletIntents).values(row as any)
    reply.code(201)
    return { intent: row, decoded, scam, caps, overCap: caps.overCap, note: 'unsigned — Arturita never signs; approval + WalletConnect handoff is E2 (blocked on S4)' }
  })

  // Attach a simulation result to a prepared intent (route does eth_call/estimate
  // upstream; here we interpret the raw result into a display summary).
  app.post('/api/orgs/:orgId/arturita/wallet/:intentId/simulate', async (req, reply) => {
    const { orgId, intentId } = req.params as any
    let b: z.infer<typeof SimulateBody>
    try { b = SimulateBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }
    const intent = await db.query.walletIntents.findFirst({
      where: and(eq(schema.walletIntents.id, intentId), eq(schema.walletIntents.orgId, orgId)),
    })
    if (!intent) return reply.code(404).send({ error: 'wallet intent not found' })
    const sim = summarizeSimulation(b)
    await db.update(schema.walletIntents).set({ simResult: sim as any, status: 'simulated' })
      .where(eq(schema.walletIntents.id, intentId))
    return { intent: { ...intent, simResult: sim, status: 'simulated' }, simulation: sim }
  })

  // List prepared/simulated intents (never any key material to expose).
  app.get('/api/orgs/:orgId/arturita/wallet/intents', async (req) => {
    const { orgId } = req.params as any
    const intents = await db.select().from(schema.walletIntents)
      .where(eq(schema.walletIntents.orgId, orgId)).orderBy(desc(schema.walletIntents.createdAt)).limit(100)
    return { intents }
  })

  // ── E2 (S4) — wallet POLICY config (autonomy line + caps + switches) ────────
  // Read the org's policy (fail-closed defaults when unset). No key material.
  app.get('/api/orgs/:orgId/arturita/wallet/policy', async (req) => {
    const { orgId } = req.params as any
    const row = await db.query.walletPolicy.findFirst({ where: eq(schema.walletPolicy.orgId, orgId) })
    const resolved = resolvePolicy(row ? {
      perTxThresholdUsd: row.perTxThresholdUsd, perDayCapUsd: row.perDayCapUsd,
      allowlist: row.allowlist ?? [], autonomousSigningEnabled: row.autonomousSigningEnabled,
      mainnetEnabled: row.mainnetEnabled,
    } : null)
    return { policy: resolved, defaultThresholdUsd: DEFAULT_PER_TX_THRESHOLD_USD, signerModels: SIGNER_MODELS, configured: !!row }
  })

  // Upsert the policy. Enabling autonomous/mainnet signing is deliberate + explicit
  // (both default off). No key ever passes through here.
  app.put('/api/orgs/:orgId/arturita/wallet/policy', async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof PolicyBody>
    try { b = PolicyBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }
    const existing = await db.query.walletPolicy.findFirst({ where: eq(schema.walletPolicy.orgId, orgId) })
    const row = {
      orgId,
      perTxThresholdUsd: b.perTxThresholdUsd ?? existing?.perTxThresholdUsd ?? null,
      perDayCapUsd: b.perDayCapUsd ?? existing?.perDayCapUsd ?? null,
      allowlist: b.allowlist ?? existing?.allowlist ?? [],
      autonomousSigningEnabled: b.autonomousSigningEnabled ?? existing?.autonomousSigningEnabled ?? false,
      mainnetEnabled: b.mainnetEnabled ?? existing?.mainnetEnabled ?? false,
      updatedAt: new Date(),
    }
    if (existing) await db.update(schema.walletPolicy).set(row as any).where(eq(schema.walletPolicy.orgId, orgId))
    else await db.insert(schema.walletPolicy).values(row as any)
    return { policy: resolvePolicy(row) }
  })

  // Evaluate a prepared+simulated intent against the org policy → the decision
  // (autonomous_sign | require_approval | refuse) + the fail-closed signing gate.
  // This does NOT sign — real signing is the go-live keystore wiring, and it is
  // impossible on mainnet this wave (WALLET_MAINNET_ENABLED default false).
  app.post('/api/orgs/:orgId/arturita/wallet/:intentId/evaluate', async (req, reply) => {
    const { orgId, intentId } = req.params as any
    let b: z.infer<typeof EvaluateBody>
    try { b = EvaluateBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }
    const intent = await db.query.walletIntents.findFirst({
      where: and(eq(schema.walletIntents.id, intentId), eq(schema.walletIntents.orgId, orgId)),
    })
    if (!intent) return reply.code(404).send({ error: 'wallet intent not found' })

    const row = await db.query.walletPolicy.findFirst({ where: eq(schema.walletPolicy.orgId, orgId) })
    const policy = row ? {
      perTxThresholdUsd: row.perTxThresholdUsd, perDayCapUsd: row.perDayCapUsd,
      allowlist: row.allowlist ?? [], autonomousSigningEnabled: row.autonomousSigningEnabled,
      mainnetEnabled: row.mainnetEnabled,
    } : null

    // Simulation gate: explicit override, else the stored sim result's ok.
    const sim = b.simulated != null ? { ok: b.simulated }
      : (intent.simResult && typeof (intent.simResult as any).ok === 'boolean' ? { ok: (intent.simResult as any).ok } : null)

    const evaluation = evaluateWalletPolicy({
      valueUsd: b.valueUsd, spentTodayUsd: b.spentTodayUsd ?? 0, chainId: b.chainId,
      simulation: sim, scam: b.scam ?? null, to: intent.toAddress ?? '', policy,
    })
    const signingGate = checkSigningGate({ decision: evaluation.decision, chainId: b.chainId, policy })

    return {
      evaluation, signingGate, network: classifyNetwork(b.chainId),
      note: evaluation.decision === 'require_approval'
        ? 'Route to an A2 wallet_tx approval (operator confirms). Arturita does not sign this one.'
        : evaluation.decision === 'refuse'
          ? 'Refused (fail-closed). Not signable.'
          : 'Autonomous-eligible per policy. Real signing is gated by the keystore layer + WALLET_MAINNET_ENABLED (testnet only this wave).',
    }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/wallet/prepare', { summary: 'Build + decode + scam-check an UNSIGNED wallet tx (no signing)', tag: 'arturita', body: PrepareBody })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/wallet/:intentId/simulate', { summary: 'Attach a simulation result to a prepared wallet intent', tag: 'arturita', body: SimulateBody })
  documentEndpoint('GET', '/api/orgs/:orgId/arturita/wallet/intents', { summary: 'List prepared/simulated wallet intents (no key material)', tag: 'arturita' })
  documentEndpoint('GET', '/api/orgs/:orgId/arturita/wallet/policy', { summary: 'Read the wallet autonomy policy (thresholds/caps/switches; no key material)', tag: 'arturita' })
  documentEndpoint('PUT', '/api/orgs/:orgId/arturita/wallet/policy', { summary: 'Set the wallet autonomy policy (per-tx threshold/per-day cap/allowlist/switches)', tag: 'arturita', body: PolicyBody })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/wallet/:intentId/evaluate', { summary: 'Evaluate a wallet intent vs policy → autonomous_sign|require_approval|refuse (no signing)', tag: 'arturita', body: EvaluateBody })
}
