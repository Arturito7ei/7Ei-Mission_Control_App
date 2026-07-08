import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseReasoningEffort, mapReasoningEffort,
  resolveModelProfile, DEFAULT_MODEL,
  decideModelTier, parseTierOverride, parseTierOverrideConfig,
  providerForModel, planWakeModel,
  buildModelProfilePatch, flattenModelOptions,
  type AgentModelRow, type ModelProfile,
} from '../services/model-profile'

// ─── reasoning effort ──────────────────────────────────────────────────────────

test('[P2] parseReasoningEffort: known values pass, unknown → null (provider default)', () => {
  assert.equal(parseReasoningEffort('low'), 'low')
  assert.equal(parseReasoningEffort('MEDIUM'), 'medium')
  assert.equal(parseReasoningEffort(' High '), 'high')
  assert.equal(parseReasoningEffort('ultra'), null)
  assert.equal(parseReasoningEffort(null), null)
  assert.equal(parseReasoningEffort(''), null)
})

test('[P2] mapReasoningEffort: per-provider representation; null effort → {}', () => {
  assert.deepEqual(mapReasoningEffort('anthropic', null), {})
  assert.deepEqual(mapReasoningEffort('anthropic', 'high'), { anthropicThinkingBudget: 8192 })
  assert.deepEqual(mapReasoningEffort('anthropic', 'low'), { anthropicThinkingBudget: 1024 })
  assert.deepEqual(mapReasoningEffort('google', 'medium'), { geminiThinkingBudget: 4096 })
  assert.deepEqual(mapReasoningEffort('gemini', 'medium'), { geminiThinkingBudget: 4096 })
  // OpenAI + any OpenAI-compatible host → reasoning_effort passthrough
  assert.deepEqual(mapReasoningEffort('openai', 'high'), { openaiReasoningEffort: 'high' })
  assert.deepEqual(mapReasoningEffort('deepseek', 'low'), { openaiReasoningEffort: 'low' })
})

test('[P2] mapReasoningEffort: budget stays under a typical 4096 max_tokens for low/medium', () => {
  assert.ok((mapReasoningEffort('anthropic', 'low').anthropicThinkingBudget ?? 0) < 4096)
})

// ─── profile resolution ────────────────────────────────────────────────────────

test('[P2] resolveModelProfile: bare agent (only llmModel) → primary=llmModel, cheap off (unchanged)', () => {
  const p = resolveModelProfile({ llmModel: 'claude-opus-4-6', llmProvider: 'anthropic' })
  assert.equal(p.primary, 'claude-opus-4-6')
  assert.equal(p.cheap, null)
  assert.equal(p.cheapEnabled, false)
  assert.equal(p.reasoningEffort, null)
})

test('[P2] resolveModelProfile: empty agent → module default primary', () => {
  assert.equal(resolveModelProfile({}).primary, DEFAULT_MODEL)
})

test('[P2] resolveModelProfile: primaryModel overrides llmModel', () => {
  const p = resolveModelProfile({ llmModel: 'claude-sonnet-4-20250514', primaryModel: 'claude-opus-4-6' })
  assert.equal(p.primary, 'claude-opus-4-6')
})

test('[P2] resolveModelProfile: cheap enabled only when flag truthy AND cheap model set', () => {
  // flag on but no model → not enabled
  assert.equal(resolveModelProfile({ cheapModelEnabled: 1 }).cheapEnabled, false)
  // model set but flag off → not enabled
  assert.equal(resolveModelProfile({ cheapModel: 'claude-haiku-4-5-20251001' }).cheapEnabled, false)
  // both → enabled (accepts 1 or true)
  assert.equal(resolveModelProfile({ cheapModel: 'x', cheapModelEnabled: 1 }).cheapEnabled, true)
  assert.equal(resolveModelProfile({ cheapModel: 'x', cheapModelEnabled: true }).cheapEnabled, true)
})

test('[P2] resolveModelProfile: reasoningEffort parsed off the row', () => {
  assert.equal(resolveModelProfile({ reasoningEffort: 'high' }).reasoningEffort, 'high')
  assert.equal(resolveModelProfile({ reasoningEffort: 'bogus' }).reasoningEffort, null)
})

// ─── tier override parsing ──────────────────────────────────────────────────────

test('[P2] parseTierOverride: primary|cheap|auto, else null', () => {
  assert.equal(parseTierOverride('primary'), 'primary')
  assert.equal(parseTierOverride('CHEAP'), 'cheap')
  assert.equal(parseTierOverride('auto'), 'auto')
  assert.equal(parseTierOverride('whatever'), null)
})

test('[P2] parseTierOverrideConfig: per-agent key wins over org default', () => {
  const cfg = { modelTierOverride: 'primary', 'modelTierOverride:a1': 'cheap' }
  assert.equal(parseTierOverrideConfig(cfg, 'a1'), 'cheap')
  assert.equal(parseTierOverrideConfig(cfg, 'a2'), 'primary')
  assert.equal(parseTierOverrideConfig({}, 'a1'), null)
  assert.equal(parseTierOverrideConfig(null), null)
})

// ─── the routing decision ───────────────────────────────────────────────────────

const withCheap = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  primary: 'claude-opus-4-6', cheap: 'claude-haiku-4-5-20251001', cheapEnabled: true, reasoningEffort: null, ...over,
})

test('[P2] decideModelTier: cheap disabled → always primary (default for every existing agent)', () => {
  const profile: ModelProfile = { primary: 'claude-opus-4-6', cheap: null, cheapEnabled: false, reasoningEffort: null }
  const d = decideModelTier({ profile, workMode: 'ask' })
  assert.equal(d.tier, 'primary')
  assert.equal(d.model, 'claude-opus-4-6')
})

test('[P2] decideModelTier: ask-mode → cheap; execute → primary', () => {
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'ask' }).tier, 'cheap')
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'execute' }).tier, 'primary')
})

test('[P2] decideModelTier: orchestrator execute → primary (heavier reasoning)', () => {
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'execute', isOrchestrator: true }).tier, 'primary')
})

test('[P2] decideModelTier: explicit stakes hint wins over workMode', () => {
  // low-stakes even on an execute turn → cheap
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'execute', stakes: 'low' }).tier, 'cheap')
  // high-stakes even on an ask turn → primary
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'ask', stakes: 'high' }).tier, 'primary')
})

test('[P2] decideModelTier: explicit override beats auto routing', () => {
  // override cheap on an execute turn
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'execute', override: 'cheap' }).tier, 'cheap')
  // override primary on an ask turn
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'ask', override: 'primary' }).tier, 'primary')
  // 'auto' override → normal routing applies
  assert.equal(decideModelTier({ profile: withCheap(), workMode: 'ask', override: 'auto' }).tier, 'cheap')
})

test('[P2] decideModelTier: cheap model returned as the concrete model id', () => {
  const d = decideModelTier({ profile: withCheap(), workMode: 'ask' })
  assert.equal(d.model, 'claude-haiku-4-5-20251001')
})

// ─── provider resolution ────────────────────────────────────────────────────────

test('[P2] providerForModel: catalogue exact match', () => {
  assert.equal(providerForModel('claude-haiku-4-5-20251001', 'openai'), 'anthropic')
  assert.equal(providerForModel('gpt-4o-mini', 'anthropic'), 'openai')
  assert.equal(providerForModel('gemini-2.0-flash', 'anthropic'), 'google')
})

test('[P2] providerForModel: prefix inference for uncatalogued ids', () => {
  assert.equal(providerForModel('claude-future-9', 'openai'), 'anthropic')
  assert.equal(providerForModel('o3-mini', 'anthropic'), 'openai')
  assert.equal(providerForModel('deepseek-vX', 'anthropic'), 'deepseek')
})

test('[P2] providerForModel: fully-custom id falls back to the agent provider', () => {
  assert.equal(providerForModel('meta-llama/Llama-3.3-70B', 'together'), 'together')
  assert.equal(providerForModel('', 'anthropic'), 'anthropic')
})

// ─── the executor's one call ────────────────────────────────────────────────────

test('[P2] planWakeModel: bare agent → primary=llmModel with its provider (no behaviour change)', () => {
  const agent: AgentModelRow = { llmModel: 'claude-sonnet-4-20250514', llmProvider: 'anthropic' }
  const plan = planWakeModel(agent, { workMode: 'execute' })
  assert.equal(plan.tier, 'primary')
  assert.equal(plan.model, 'claude-sonnet-4-20250514')
  assert.equal(plan.provider, 'anthropic')
  assert.equal(plan.reasoningEffort, null)
})

test('[P2] planWakeModel: ask-mode with a cross-provider cheap model routes cheap + infers provider', () => {
  const agent: AgentModelRow = {
    llmModel: 'claude-opus-4-6', llmProvider: 'anthropic',
    cheapModel: 'gpt-4o-mini', cheapModelEnabled: 1, reasoningEffort: 'medium',
  }
  const plan = planWakeModel(agent, { workMode: 'ask' })
  assert.equal(plan.tier, 'cheap')
  assert.equal(plan.model, 'gpt-4o-mini')
  assert.equal(plan.provider, 'openai')          // inferred, not the agent's anthropic
  assert.equal(plan.reasoningEffort, 'medium')   // carried through
})

test('[P2] planWakeModel: cheap enabled but execute turn → still primary (cost lever only on light turns)', () => {
  const agent: AgentModelRow = {
    llmModel: 'claude-opus-4-6', llmProvider: 'anthropic',
    cheapModel: 'claude-haiku-4-5-20251001', cheapModelEnabled: 1,
  }
  const plan = planWakeModel(agent, { workMode: 'execute' })
  assert.equal(plan.tier, 'primary')
  assert.equal(plan.model, 'claude-opus-4-6')
})

test('[P2] planWakeModel: explicit cheap override forces cheap even on an execute turn', () => {
  const agent: AgentModelRow = {
    llmModel: 'claude-opus-4-6', llmProvider: 'anthropic',
    cheapModel: 'claude-haiku-4-5-20251001', cheapModelEnabled: 1,
  }
  const plan = planWakeModel(agent, { workMode: 'execute', override: 'cheap' })
  assert.equal(plan.tier, 'cheap')
  assert.equal(plan.model, 'claude-haiku-4-5-20251001')
})

// ─── config surface: patch builder ──────────────────────────────────────────────

test('[P2] buildModelProfilePatch: partial update — only present keys are set', () => {
  const r = buildModelProfilePatch({ cheapModelEnabled: true })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.set, { cheapModelEnabled: true })
})

test('[P2] buildModelProfilePatch: empty model id clears the override (→ null)', () => {
  const r = buildModelProfilePatch({ primaryModel: '  ', cheapModel: 'claude-haiku-4-5-20251001' })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.set, { primaryModel: null, cheapModel: 'claude-haiku-4-5-20251001' })
})

test('[P2] buildModelProfilePatch: enabled accepts bool / 1 / "true"', () => {
  for (const v of [true, 1, '1', 'true']) {
    const r = buildModelProfilePatch({ cheapModelEnabled: v })
    assert.equal(r.ok && r.set.cheapModelEnabled, true)
  }
  const off = buildModelProfilePatch({ cheapModelEnabled: false })
  assert.equal(off.ok && off.set.cheapModelEnabled, false)
})

test('[P2] buildModelProfilePatch: reasoningEffort validates; empty → null; bad → error', () => {
  const good = buildModelProfilePatch({ reasoningEffort: 'high' })
  assert.equal(good.ok && good.set.reasoningEffort, 'high')
  const cleared = buildModelProfilePatch({ reasoningEffort: '' })
  assert.equal(cleared.ok, true)
  if (cleared.ok) assert.equal(cleared.set.reasoningEffort, null)
  const bad = buildModelProfilePatch({ reasoningEffort: 'ultra' })
  assert.equal(bad.ok, false)
})

test('[P2] buildModelProfilePatch: no keys → empty set (route rejects as nothing-to-update)', () => {
  const r = buildModelProfilePatch({})
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(Object.keys(r.set).length, 0)
})

// ─── config surface: model options ──────────────────────────────────────────────

test('[P2] flattenModelOptions: catalogue flattened with provider + tier', () => {
  const opts = flattenModelOptions()
  const haiku = opts.find(o => o.id === 'claude-haiku-4-5-20251001')
  assert.ok(haiku)
  assert.equal(haiku!.provider, 'anthropic')
  assert.equal(haiku!.tier, 'fast')
})

test('[P2] flattenModelOptions: custom entries appended + de-duped by id', () => {
  const opts = flattenModelOptions([
    { provider: 'together', model: 'meta-llama/Llama-3.3-70B', label: 'Together Llama' },
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }, // dup of catalogue → dropped
  ])
  const custom = opts.filter(o => o.custom)
  assert.equal(custom.length, 1)
  assert.equal(custom[0].id, 'meta-llama/Llama-3.3-70B')
  assert.equal(custom[0].tier, 'custom')
  // catalogue haiku still present exactly once
  assert.equal(opts.filter(o => o.id === 'claude-haiku-4-5-20251001').length, 1)
})
