import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWorkMode, isAskMode, buildAskSystemPrompt, WORK_MODES, ASK_ANSWER_KIND } from '../services/askmode'

// A minimal agent row — only the fields buildAskSystemPrompt reads.
const agent = (p: Record<string, unknown> = {}): any => ({
  id: 'a1', orgId: 'o1', name: 'Dev', role: 'Engineer', agentType: 'worker',
  advisorPersona: null, personality: null, persona: null, expertise: null, cv: null,
  skills: [], title: null, reportsTo: null, llmModel: null, llmProvider: null, ...p,
})

// ─── normalizeWorkMode / isAskMode ───────────────────────────────────────────

test('[MCA-83] normalizeWorkMode defaults anything unknown to execute', () => {
  for (const v of [undefined, null, '', 'nope', 'EXEC', 42, {}]) assert.equal(normalizeWorkMode(v), 'execute')
})

test('[MCA-83] normalizeWorkMode recognizes ask, case/whitespace-insensitive', () => {
  for (const v of ['ask', 'ASK', ' Ask ', 'aSk']) assert.equal(normalizeWorkMode(v), 'ask')
  assert.equal(normalizeWorkMode('execute'), 'execute')
})

test('[MCA-83] isAskMode is true only for ask', () => {
  assert.equal(isAskMode('ask'), true)
  assert.equal(isAskMode('execute'), false)
  assert.equal(isAskMode(undefined), false)
  assert.equal(isAskMode('anything'), false)
})

test('[MCA-83] WORK_MODES + ASK_ANSWER_KIND are the expected constants', () => {
  assert.deepEqual(WORK_MODES, ['execute', 'ask'])
  assert.equal(ASK_ANSWER_KIND, 'answer')
})

// ─── buildAskSystemPrompt ────────────────────────────────────────────────────

test('[MCA-83] ask prompt states identity, org mission, and the single-reply constraint', () => {
  const p = buildAskSystemPrompt(agent(), { org: { mission: 'Ship the future', culture: 'Bias to action' } as any })
  assert.match(p, /You are Dev, Engineer at 7Ei/)
  assert.match(p, /Ship the future/)
  assert.match(p, /Bias to action/)
  assert.match(p, /ASK mode/)
  assert.match(p, /single reply/)
})

test('[MCA-83] ask prompt omits the execute-loop directive machinery (no lying about tools)', () => {
  // The lean prompt must NOT advertise [REMEMBER]/[WEBHOOK]/[DELEGATE] — an ask
  // can't run them, so telling the model it can would produce dropped side-effects.
  const p = buildAskSystemPrompt(agent({ persona: 'terse', expertise: 'backends' }))
  assert.doesNotMatch(p, /\[REMEMBER/)
  assert.doesNotMatch(p, /\[WEBHOOK/)
  assert.doesNotMatch(p, /\[DELEGATE/)
})

test('[MCA-83] ask prompt folds in memory + persona/expertise + reporting line when present', () => {
  const p = buildAskSystemPrompt(agent({ persona: 'terse', expertise: 'backends', title: 'Staff Eng' }), {
    memoryBlock: '=== MEMORY ===\nprefers TypeScript',
    hierarchy: { title: 'Staff Eng', manager: 'Ada', reports: ['Junior'] },
  })
  assert.match(p, /prefers TypeScript/)
  assert.match(p, /terse/)
  assert.match(p, /backends/)
  assert.match(p, /Reports to: Ada/)
  assert.match(p, /Direct reports: Junior/)
})

test('[MCA-83] ask prompt honours advisor persona over the plain identity line', () => {
  const p = buildAskSystemPrompt(agent({ agentType: 'advisor', advisorPersona: 'Warren Buffett' }))
  assert.match(p, /Silver Board Advisor/)
  assert.match(p, /Warren Buffett/)
})
