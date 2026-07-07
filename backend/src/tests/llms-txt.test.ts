import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLlmsTxt } from '../services/llms-txt'

// ─── llms.txt agent-facing doc (MCA-85 D2) ───────────────────────────────────

test('[MCA-85] llms.txt follows the llmstxt.org shape: H1 title + blockquote summary', () => {
  const txt = buildLlmsTxt()
  const lines = txt.split('\n')
  assert.equal(lines[0], '# 7Ei Mission Control', 'must open with a single H1 title')
  assert.match(txt, /\n> .+/, 'must have a blockquote summary')
})

test('[MCA-85] llms.txt points at the OpenAPI spec and the onboard command', () => {
  const txt = buildLlmsTxt()
  assert.match(txt, /\/api\/openapi\.json/, 'links the machine-readable OpenAPI spec (D1)')
  assert.match(txt, /onboard/, 'documents the onboard command')
  assert.match(txt, /@7ei\/mc/, 'names the CLI package')
  assert.match(txt, /MC_AGENT_TOKEN/, 'explains how the agent authenticates')
})

test('[MCA-85] llms.txt interpolates the live API host into absolute links', () => {
  const txt = buildLlmsTxt({ apiUrl: 'https://api.7ei.ai/' })
  assert.match(txt, /https:\/\/api\.7ei\.ai\/api\/openapi\.json/, 'apiUrl is trimmed + used in links')
  assert.doesNotMatch(txt, /https:\/\/api\.7ei\.ai\/\/api/, 'no double slash from a trailing-slash apiUrl')
})

test('[MCA-85] llms.txt defaults to the prod Fly host when no apiUrl is given', () => {
  const txt = buildLlmsTxt()
  assert.match(txt, /https:\/\/7ei-backend\.fly\.dev\/api\/openapi\.json/)
})
